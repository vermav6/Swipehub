// Setting up dependencies
const functions = require("firebase-functions");
const axios = require("axios");
const admin = require("firebase-admin");
// Configuring database
admin.initializeApp({ databaseURL: "https://theswipehub-default-rtdb.firebaseio.com/" });
const sessionDb = admin.database();
// Configuring credentials
const apiToken = functions.config().tmdb.key;
const TelegramURL = functions.config().telegram.url;
const TelegramToken = functions.config().telegram.token;
const TelegramChatID = functions.config().telegram.chatid;
const expectedToken = TelegramToken.split(":")[1].toLowerCase();

/* 
 - Firebase function
 - This HTTP method is called whenever a user creates or joins a session
*/
exports.registerTenant = functions.https.onCall(async (data, context) => {
  try {
    // App check verification, to make sure only the registered domains are calling this API.
    if (context.app == undefined) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "The function must be called from an App Check verified app.");
    }
    // If the user is trying to join a session
    if (data.requestType === "join") {
      const username = data.username;
      const sessionId = data.sessionId;
      if (!usernameValidator(username) || !sessionIdValidator(sessionId)) { // Validate username and session Id
        return ({ status: "error", message: "Username or SessionId is not valid!" });
      }
      const snap = await sessionDb.ref(sessionId).once("value"); // Retrieve session data from Firebase
      if (!snap.val()) {
        return ({ status: "error", message: "SessionId does not exist!" });
      }
      if (!(snap.val()["sessionActivity"]["isValid"])) {
        return ({ status: "error", message: "This session has ended. Please create a new session!" });
      }
      if (!snap.val()["sessionActivity"]["users"][username] && Object.keys(snap.val()["sessionActivity"]["users"]).length >= 8) {
        return ({ status: "error", message: "Session is currently full. Please join another session or create a new one." });
      }
      const isCreator = snap.val()["sessionInfo"]["creator"] == username;
      const token = await generateJWTToken(username, sessionId, isCreator); // Generate JWT
      if (!snap.val().sessionActivity.users[username] || !snap.val().sessionActivity.users[username]["isActive"]) { // If user is not already present in session
        sessionDb.ref(sessionId).update({
          [`sessionActivity/users/${username}/joinedAt`]: new Date().getTime(),
          [`sessionActivity/users/${username}/isActive`]: true,
          [`sessionActivity/users/${username}/swipes`]: {}, // Default swipe state to ensure consistency
        });
      } else {
        sessionDb.ref(sessionId).update({
          [`sessionActivity/users/${username}/joinedAt`]: new Date().getTime(),
          [`sessionActivity/users/${username}/isActive`]: true,
        });
      }
      return ({ status: "success", token: token, isCreator: isCreator });
    } else if (data.requestType === "create") {  // If the user is trying to create a new session
      const sessionId = await generateSessionId();
      const username = data.username;
      if (!usernameValidator(username)) { // Validate username 
        return ({ status: "error", message: "Username is not valid!" });
      }
      // Parsing data from request
      const categories = data.categories;
      const languages = data.language;
      const platform = data.platform;
      const region = data.region;
      const type = data.type;
      const order = data.order;
      // Update Database with session
      sessionDb.ref(sessionId).set({
        sessionInfo: {
          categories: categories,
          creator: username,
          languages: languages,
          platform: platform,
          region: region,
          isMovie: type,
          order: order,
          createdAt: new Date().getTime(),
        },
        sessionActivity: {
          contentOrder: [],
          isValid: true,
          region: region,
          users:
          {
            [username]: {
              joinedAt: new Date().getTime(),
              isActive: true,
            },
          },
        },
      });
      const token = await generateJWTToken(username, sessionId, true); // Generate JWT token
      return ({ token: token, sessionId: sessionId, userId: username });
    } else {
      throw new functions.https.HttpsError("invalid-argument", "The function must be called with correct request type");
    }
  } catch (err) {
    sendErrorNotification("Register Tenant", err);
  }
});

/* 
  - Firebase function
  - This HTTP method is called whenever a user requests for additional cards
*/
exports.subsequentCards = functions.https.onCall(async (data, context) => {
  try {
    // App check verification, to make sure only the registered domains are calling this API.
    if (context.app == undefined) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "The function must be called from an App Check verified app.");
    }
    const sessionId = context.auth.token.sessionId;   // retrieving sessionId
    const snap = await sessionDb.ref(sessionId).once("value");
    if (!snap.val() || !snap.val()["sessionActivity"]["isValid"]) {
      return ({ status: "error", message: "Session has ended. Please create a new session!" });
    }
    const mediaOrder = snap.val()["sessionActivity"]["mediaOrder"];
    const mediaOrderLength = mediaOrder.length;
    if (mediaOrderLength >= 300) {     // load no more than 300 movie cards for one session
      if (!(mediaOrder.includes("null"))) {
        mediaOrder.push("null");    // if no movie card has a null reference, we add one movie card with value null
      }
    } else if (!(mediaOrder.includes("null"))) {  // no null card yet
      const page = getPageNumber(mediaOrderLength);
      const sessionInfo = snap.val()["sessionInfo"];
      const newData = await mediaData(sessionInfo, page);
      for (const mediaId of newData) {
        if (!(mediaOrder.includes(mediaId))) {   // append new data to media order, checking if the mediaId already exists
          mediaOrder.push(mediaId);
        }
      }
    }
    sessionDb.ref(sessionId).update({
      "sessionActivity/mediaOrder": mediaOrder,   // update the rtdb with the new media order
    });
    return;
  } catch (err) {
    sendErrorNotification("Register Tenant", err);   // SEV alert notification if the function fails
  }
});

/* 
 - Firebase cloud function to trigger the database
 - This function takes the key as sessionId and the sessionInfo as child value, and generates mediaData corresponding to session
 - info which further updates the sessionDb for that sessionId
*/
exports.generateInitialData = functions.database.ref("{sessionId}")
  .onCreate(async (snapshot, context) => {
    const sessionInfo = snapshot.val().sessionInfo;
    const sessionId = snapshot.key;
    const dataSet = await mediaData(sessionInfo, 1);
    return sessionDb.ref(sessionId).child("sessionActivity").update({
      mediaOrder: dataSet,
    });
  });

/* 
 - Firebase function
 - This HTTP method is called whenever a user leaves a session
 */
exports.leaveSession = functions.https.onCall(async (data, context) => {
  try {
    // App check verification, to make sure only the registered domains are calling this API.
    if (context.app == undefined) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "The function must be called from an App Check verified app.");
    }
    const userId = context.auth.token.userId;
    const sessionId = context.auth.token.sessionId;
    const isCreator = context.auth.token.isCreator;
    // if the session is ended by creator, the session validity becomes false which is updated in databse, and correspondingly
    // other users who might still be in the session are kicked out of the session (session ends)
    if (isCreator) {
      sessionDb.ref(sessionId).child("sessionActivity").update({
        isValid: false,
      });
    }
    // if the session is ended by anybody other than creator, the users activity becomes false and the session ends for him.
    // session does not end
    else {
      sessionDb.ref(sessionId).child("sessionActivity").child("users").child(userId).update({
        isActive: false,
      });
    }
    // user deleted from firebase auth
    await admin.auth().deleteUser(`${sessionId}|${userId}|${isCreator}`);
    return;
  } catch (err) {
    sendErrorNotification("Leave Session", err);   // SEV alert notification if the function fails
  }
});

exports.deploymessages = functions.https.onRequest(async (req, res) => {
  try {
    res.set("Access-Control-Allow-Origin", "*");
    const title = req.body.title;
    const key = req.query.token;
    const branch = req.body.branch;
    const status = req.body.state;
    if (title == undefined || status == undefined || branch == undefined) {
      res.status(200).send("Data Error");
      return;
    }
    if (key == undefined || key.toLowerCase() != expectedToken) {
      res.status(200).send("Unauthorized!");
      return;
    }
    if (title.includes(":NF:")) {
      res.status(200).send("Done!");
      return;
    }
    const content = `Deployment: ${title}\nBranch : ${branch}\nStatus: ${status}`;
    try {
      await axios.get(
        `${TelegramURL}/${TelegramToken}/sendMessage?text=${content}&chat_id=${TelegramChatID}`,
      );
      res.status(200).send("Done");
    } catch (error) {
      res.status(200).send("Error");
    }
    return;
  } catch (error) {
    functions.logger.error(error);
    sendErrorNotification("deploymessages", error);
    res.status(500).send("error");
  }
});

/**
 * @param  {string} sessionInfo
 * @param  {number} page
 */
async function mediaData(sessionInfo, page) {
  // Retrieves the parameters that the creator chose for the session
  const categories = sessionInfo.categories;
  const languages = sessionInfo.languages;
  const platform = sessionInfo.platform;
  const region = sessionInfo.region;
  let sortby = sessionInfo.order;
  const movie = sessionInfo.isMovie;
  let dataSet = [];
  // If the content type is Movie
  if (movie === true) {
    if (sortby == "Popularity") {
      sortby = "popularity.desc";
    } else if (sortby == "Release") {
      sortby = "primary_release_date.desc";
    } else if (sortby == "Revenue") {
      sortby = "revenue.desc";
    }
    // A dataSet for movies is generated based upon the parameters
    dataSet = await generateMovieList(
      languages,
      categories,
      platform,
      region,
      sortby,
      page,
    );
  }
  // If the content type is TV
  else {
    if (sortby == "Popularity") {
      sortby = "popularity.desc";
    } else if (sortby == "Release") {
      sortby = "first_air_date.desc";
    } else if (sortby == "Revenue") {
      sortby = "popularity.desc";
    }
    dataSet = await generateTVList(
      languages,
      categories,
      platform,
      region,
      sortby,
      page,
    );
  }
  // If the dataSet populated contains less than 20 movies, then a null card is added depicting the end
  if (dataSet.length < 20) {
    dataSet.push("null");
  }
  return dataSet;
}

/**
 * @param {string} caller
 * @param {string} error
 * @return {boolean}
 */
async function sendErrorNotification(caller, error) {
  try {
    const content = `Error Notification.\n Raised by: ${caller}\n Error: ${error}`;
    await axios.get(
      `${TelegramURL}/${TelegramToken}/sendMessage?text=${content}&chat_id=${TelegramChatID}`,
    );
    functions.logger.error(error);
    return true;
  } catch (err) {
    functions.logger.error(err);
    return false;
  }
}

/**
 * @param  {string} lang
 * @param  {string} genres
 * @param  {string} platform
 * @param  {string} region
 * @param  {string} sort
 * @param  {number} page
 */
async function generateMovieList(lang, genres, platform, region, sort, page) {
  // API call to TMDB to generate movie list
  const url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiToken}`;
  // An axios call to get the data
  const resp = await axios.get(
    `${url}&with_original_language=${lang}&with_genres=${genres}&sort_by=${sort}&with_watch_providers=${platform}&watch_region=${region}&page=${page}`,
  );
  // parsing on the data and storing the media and movie data in firestore
  const data = resp.data.results;
  const res = [];
  for (let i = 0; i < data.length; i++) {
    const id = data[i].id.toString();
    // media content is stored in firestore
    const sessionDb = admin.firestore().collection("media").doc(id);
    const doc = await sessionDb.get();
    if (!doc.exists) {
      const deepURL = `https://api.themoviedb.org/3/movie/${data[i].id}?api_key=${apiToken}&append_to_response=videos,watch/providers`;
      const deepSearchResp = await axios.get(deepURL);
      const newData = deepSearchResp.data;
      const oldGenre = newData.genres;
      const newGenre = [];
      for (let i = 0; i < oldGenre.length; i++) {
        newGenre.push(oldGenre[i].id);
      }
      newData["genre_ids"] = newGenre;
      const allVideos = newData.videos.results;
      let videoUrl = "";
      for (let i = 0; i < allVideos.length; i++) {
        if (allVideos[i].official == true && allVideos[i].site == "YouTube" && allVideos[i].type == "Trailer") {
          videoUrl = `https://www.youtube.com/watch?v=${allVideos[i].key}`;
        }
      }
      newData["trailerURL"] = videoUrl;
      const allProviders = newData["watch/providers"].results;
      const providers = {};
      for (const i of Object.keys(allProviders)) {
        providers[i] = {};
        if (allProviders[i]["buy"]) {
          for (let index = 0; index < allProviders[i]["buy"].length; index++) {
            const element = allProviders[i]["buy"][index].provider_id;
            providers[i][element] = {};
            providers[i][element]["logo"] = `https://image.tmdb.org/t/p/original/${allProviders[i]["buy"][index].logo_path}`;
            providers[i][element]["name"] = `${allProviders[i]["buy"][index].provider_name}`;
          }
        }
        if (allProviders[i]["rent"]) {
          for (let index = 0; index < allProviders[i]["rent"].length; index++) {
            const element = allProviders[i]["rent"][index].provider_id;
            providers[i][element] = {};
            providers[i][element]["logo"] = `https://image.tmdb.org/t/p/original/${allProviders[i]["rent"][index].logo_path}`;
            providers[i][element]["name"] = `${allProviders[i]["rent"][index].provider_name}`;
          }
        }
        if (allProviders[i]["flatrate"]) {
          for (let index = 0; index < allProviders[i]["flatrate"].length; index++) {
            const element = allProviders[i]["flatrate"][index].provider_id;
            providers[i][element] = {};
            providers[i][element]["logo"] = `https://image.tmdb.org/t/p/original/${allProviders[i]["flatrate"][index].logo_path}`;
            providers[i][element]["name"] = `${allProviders[i]["flatrate"][index].provider_name}`;
          }
        }
      }
      newData["providers"] = providers;
      delete newData["watch/providers"];
      delete newData.video;
      delete newData.genres;
      delete newData.adult;
      delete newData.vote_average;
      delete newData.vote_count;
      delete newData.popularity;
      delete newData.videos;
      await admin
        .firestore()
        .collection("media")
        .doc(id)
        .set(newData);
    }
    res.push(id);
  }
  return res;
}

/**
 * @param  {string} lang
 * @param  {string} genres
 * @param  {string} platform
 * @param  {string} region
 * @param  {string} sort
 * @param  {number} page
 */
async function generateTVList(lang, genres, platform, region, sort, page) {
  // API call to TMDB to generate TV list
  const url = `https://api.themoviedb.org/3/discover/tv?api_key=${apiToken}`;
  // An axios call to get the data
  const resp = await axios.get(
    `${url}&with_original_language=${lang}&with_genres=${genres}&sort_by=${sort}&with_ott_providers=${platform}&ott_region=${region}&page=${page}`,
  );
  const data = resp.data.results;
  const res = [];
  for (let i = 0; i < data.length; i++) {
    const id = data[i].id.toString();
    const sessionDb = admin.firestore().collection("media").doc(id);   // content data collected and stored inside firestore
    const doc = await sessionDb.get();
    data[i]["title"] = data[i]["name"];
    data[i]["poster_path"] =
      "https://image.tmdb.org/t/p/original" + data[i]["poster_path"];
    data[i]["release_date"] = data[i]["first_air_date"];
    if (!doc.exists) {
      await admin
        .firestore()
        .collection("media")
        .doc(id)
        .set(data[i]);
    }
    res.push(id);
  }
  return res;
}

/**
 */
async function generateSessionId() {
  let id = randomSessionCode();   // random session Id generated on this function call
  const validId = true;
  while (validId) {
    const snap = await sessionDb.ref(id).once("value");   // a snapshot of the rtdb with this id
    if (!snap.val()) {
      return id;
    } else {
      id = randomSessionCode();
    }
  }
}

/**
 * @return {string} A random 6 digit code
 */
function randomSessionCode() {
  const length = 6;   // session Id is a string of length 6
  const chars = "123456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let result = "";
  for (let i = length; i > 0; --i) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * @param  {number} numberOfCards
 * @return {number} val
 */
function getPageNumber(numberOfCards) {
  const ceiledNum = Math.ceil(numberOfCards / 10);
  let val = 0;
  if (ceiledNum % 2 == 0) {
    val = ceiledNum;
  } else {
    val = (ceiledNum + 1);
  }
  return val;
}

/**
 * @param  {String} userId
 * @param  {String} sessionId
 * @param  {Boolean} isCreator
*/
async function generateJWTToken(userId, sessionId, isCreator = false) {
  // A JWT token is genereated for each user that registers into the session.
  // For Authentication and security purposes, cannot spoof data other than the one he/she is authenticated for
  const additionalClaims = {
    isCreator: isCreator,
    sessionId: sessionId,
    userId: userId,
  };
  // firebase function to generate custom JWT token with the following format
  const customToken = await admin.auth().createCustomToken(`${sessionId}|${userId}|${isCreator}`, additionalClaims);
  return customToken;
}


/**
 * @param  {string} username
 * @return {boolean} if valid or not
 */
function usernameValidator(username) {            // data username validation added for the backend
  if (username == null || username.length == 0) {
    return false;
  }
  if (reservedKeywords.includes(username.trim().toLowerCase())) {
    return false;
  }
  if (
    !username
      .toLowerCase()
      .split("")
      .every((char) => alphaNumeric.includes(char))
  ) {
    return false;
  }
  return true;
}

/**
 * @param  {string} sessionId
 * @return {boolean} if valid or not
 */
function sessionIdValidator(sessionId) {            // data sessionId validation added for the backend
  if (sessionId == null || sessionId.length != 6) {
    return false;
  }
  if (reservedKeywords.includes(sessionId.trim().toLowerCase())) {
    return false;
  }
  if (
    !sessionId
      .toLowerCase()
      .split("")
      .every((char) => alphaNumeric.includes(char))
  ) {
    return false;
  }
  return true;
}


const reservedKeywords = [
  "nigga",
];

const alphaNumeric = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
];
