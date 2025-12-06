const OAuthClient = require("intuit-oauth");
require("dotenv").config();

const {
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI,
    ENVIRONMENT,
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    throw new Error("Missing QuickBooks OAuth environment variables");
}

const oauthClient = new OAuthClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    environment: ENVIRONMENT,
});

module.exports = oauthClient;
