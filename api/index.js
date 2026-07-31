const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-SecretKey', 'X-Authorization']
}));
app.use(express.json({ limit: '50mb' }));

const settings = {
    TitleId: "24A23",
    SecretKey: "H18MD8PRB455ODG3R646CAWPXEBC7OIIZAYR1BE8UMW53S5F9R",
    ApiKey: "OC|1293481997173844|1ce33959b78ca53fc3d9970ddefc4d5c",
    Webhook: "ugyhsadjhkgbasda"
};

const DailyTees = [ // put item ids here
"",
"",
"",
"",
"",
"",
"",
"",
""
];

let currentDailyItems = [];
let lastUpdateDate = null;
let webhookSentToday = false;

async function sendwebhook(title, desc, fields, color) {
    try {
        const embed = {
            embeds: [{
                title: title,
                description: desc,
                color: color || 65280,
                fields: fields || [],
            }]
        };
        return await axios.post(settings.Webhook, embed);
    } catch(e) {
        console.error("webhook error", e.response ? e.response.data : e.message);
    }
}

function getDailyItems() {
    const today = new Date().toDateString();

    if (lastUpdateDate !== today || currentDailyItems.length === 0) {
        const shuffled = [...DailyTees].sort(() => 0.5 - Math.random());
        const selected = shuffled.slice(0, 3);

        while (selected.length < 3) {
            selected.push(DailyTees[Math.floor(Math.random() * DailyTees.length)]);
        }

        currentDailyItems = selected;
        lastUpdateDate = today;
        webhookSentToday = false;
    }

    return currentDailyItems;
}

async function sendDailyWebhookIfNeeded() {
    const today = new Date().toDateString();
    const items = getDailyItems();

    if (!webhookSentToday || lastUpdateDate !== today) {
        await sendwebhook(
            'Daily Tee Updated 😻',
            `New daily cosmetics have been selected!`,
            [
                { name: 'CosmeticStand1', value: items[0] || 'Not set', inline: true },
                { name: 'CosmeticStand2', value: items[1] || 'Not set', inline: true },
                { name: 'CosmeticStand3', value: items[2] || 'Not set', inline: true },
                { name: 'Date', value: new Date().toLocaleDateString(), inline: false }
            ],
            65280
        );
        webhookSentToday = true;
    }
}

function generateTOTD() {
    const items = getDailyItems();

    return JSON.stringify([
        {
            "PedestalID": "CosmeticStand1",
            "ItemName": items[0] || DailyTees[0],
            "StartTimeUTC": new Date().toISOString(),
                          "EndTimeUTC": new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        },
        {
            "PedestalID": "CosmeticStand2",
            "ItemName": items[1] || DailyTees[1],
            "StartTimeUTC": new Date().toISOString(),
                          "EndTimeUTC": new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        },
        {
            "PedestalID": "CosmeticStand3",
            "ItemName": items[2] || DailyTees[2],
            "StartTimeUTC": new Date().toISOString(),
                          "EndTimeUTC": new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }
    ]);
}

function getAuthHeaders() {
    return {
        "content-type": "application/json",
        "X-SecretKey": settings.SecretKey
    };
}

async function returnFunctionJson(data, funcname, funcparam = {}) {
    const userId = data.FunctionParameter?.CallerEntityProfile?.Lineage?.TitlePlayerAccountId;

    try {
        const response = await axios.post(
            `https://${settings.TitleId}.playfabapi.com/Server/ExecuteCloudScript`,
            {
                PlayFabId: userId,
                FunctionName: funcname,
                FunctionParameter: funcparam
            },
            { headers: getAuthHeaders() }
        );

        return {
            data: response.data.data.FunctionResult,
            status: response.status
        };
    } catch (error) {
        return {
            data: {},
            status: error.response?.status || 500
        };
    }
}

async function handlePlayFabFunction(req, res, funcname, funcparam = {}) {
    const result = await returnFunctionJson(req.body, funcname, funcparam);
    res.status(result.status).json(result.data);
}

async function validateNonce(nonce, oculusId) {
    try {
        const response = await axios.post(
            `https://graph.oculus.com/user_nonce_validate?nonce=${nonce}&user_id=${oculusId}&access_token=${settings.ApiKey}`,
            {},
            { headers: { "content-type": "application/json" } }
        );
        return response.data.is_valid === true;
    } catch (error) {
        console.error("Nonce validation error:", error.response?.data || error.message);
        return false;
    }
}

app.get('/', (req, res) => {
    res.status(404).send('Not Found');
});

app.post('/', (req, res) => {
    res.status(404).send('Not Found');
});

app.all('/api/PlayFabAuthentication', async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Not Found" });
    }

    const data = req.body;
    const { AppId, AppVersion, Nonce, OculusId } = data;

    if (!Nonce || !OculusId) {
        await sendwebhook(
            'PlayFab Authentication Failed 😻',
            `Missing required fields`,
            [
                { name: 'OculusId', value: OculusId || 'Not provided', inline: true },
                { name: 'Nonce', value: Nonce ? 'Provided' : 'Not provided', inline: true }
            ],
            16711680
        );
        return res.status(400).json({
            error: "Missing required fields: Nonce and OculusId are required"
        });
    }
    const isValidNonce = await validateNonce(Nonce, OculusId);
    if (!isValidNonce) {
        await sendwebhook(
            'PlayFab Authentication Failed - Invalid Nonce 😻',
            `Nonce validation failed for Oculus user`,
            [
                { name: 'OculusId', value: OculusId, inline: true },
            ],
            16711680
        );
        return res.status(403).json({
            error: "Invalid nonce - authentication failed",
            message: "The provided nonce could not be validated with Oculus"
        });
    }
    try {
        const loginReq = await axios.post(
            `https://${settings.TitleId}.playfabapi.com/Server/LoginWithServerCustomId`,
            {
                ServerCustomId: "OCULUS" + OculusId,
                CreateAccount: true
            },
            {
                headers: {
                    'X-SecretKey': settings.SecretKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (loginReq.status === 200) {
            const rjson = loginReq.data;
            const sessionTicket = rjson.data.SessionTicket;
            const entityToken = rjson.data.EntityToken.EntityToken;
            const playfabId = rjson.data.PlayFabId;
            const entityId = rjson.data.EntityToken.Entity.Id;
            const entityType = rjson.data.EntityToken.Entity.Type;
            const kidAccessToken = rjson.data.KidAccessToken;
            const kidRefreshToken = rjson.data.KidRefreshToken;
            const kidUrlBasePath = rjson.data.KidUrlBasePath;
            const locationCode = rjson.data.LocationCode;

            await axios.post(
                `https://${settings.TitleId}.playfabapi.com/Client/LinkCustomID`,
                {
                    PlayFabId: playfabId,
                    CustomId: "OCULUS" + OculusId,
                    ForceLink: true
                },
                {
                    headers: {
                        'X-Authorization': sessionTicket,
                        'Content-Type': 'application/json'
                    }
                }
            );

            await sendwebhook(
                'PlayFab Authentication Successful 😻',
                `User successfully authenticated`,
                [
                    { name: 'OculusId', value: OculusId, inline: true },
                    { name: 'PlayFabId', value: playfabId, inline: true },
                    { name: 'EntityId', value: entityId, inline: false }
                ],
                65280
            );

            res.json({
                "SessionTicket": sessionTicket,
                "EntityToken": entityToken,
                "PlayFabId": playfabId,
                "EntityId": entityId,
                "EntityType": entityType,
                "KidAccessToken": kidAccessToken,
                "KidRefreshToken": kidRefreshToken,
                "KidUrlBasePath": kidUrlBasePath,
                "LocationCode": locationCode
            });
        }
    } catch (error) {
        const banInfo = error.response?.data;
        if (banInfo?.errorCode === 1002) {
            const banMessage = banInfo.errorMessage || "No ban message provided.";
            const banDetails = banInfo.errorDetails || {};
            const banExpirationKey = Object.keys(banDetails)[0] || null;
            const banExpirationList = banDetails[banExpirationKey] || [];
            const banExpiration = banExpirationList.length > 0 ? banExpirationList[0] : "Indefinite";

            await sendwebhook(
                ' PlayFab Authentication - User Banned 😻',
                `User attempted to authenticate but is banned`,
                [
                    { name: 'OculusId', value: OculusId, inline: true },
                    { name: 'Ban Expiration', value: banExpiration, inline: true },
                    { name: 'Ban Message', value: banMessage, inline: false }
                ],
                16711680
            );

            res.status(403).json({
                "BanMessage": banExpirationKey,
                "BanExpirationTime": banExpiration
            });
        } else {
            await sendwebhook(
                'PlayFab Authentication Failed 😻',
                `Authentication error occurred`,
                [
                    { name: 'OculusId', value: OculusId, inline: true },
                    { name: 'Status Code', value: error.response?.status || 500, inline: true },
                    { name: 'Error', value: error.response?.data?.errorMessage || 'Unknown error', inline: false }
                ],
                16711680
            );

            res.status(error.response?.status || 500).json({
                error: "Authentication failed",
                message: error.response?.data?.errorMessage || "Unknown error"
            });
        }
    }
});

app.post('/api/TitleData', async (req, res) => {
    await sendDailyWebhookIfNeeded();
    const dailyTOTD = generateTOTD();

    res.json({
        "MOTD": "",
        "TOTD": dailyTOTD
    });
});

app.post('/api/photon', (req, res) => {
    const { Ticket, Nonce, AppId, Platform } = req.body;

    if (AppId !== '') {
        return res.status(403).json({ status: 'error', message: 'bad per' });
    }
    if (Platform !== 'Android') {
        return res.status(403).json({ status: 'error', message: 'Cheds' });
    }
    if (!Nonce) {
        return res.status(403).json({ status: 'error', message: 'nono you cant auth' });
    }

    res.json({
        sessionticket: Ticket,
        npmce: Nonce,
        tileid: AppId
    });
});

app.post('/api/CachePlayFabId', (req, res) => {
    const data = req.body;

    res.json({
        "Message": "Yay Your Authed",
        "PlayFabId": data.PlayFabId,
        "KidAccessToken": data.KidAccessToken,
        "KidRefreshToken": data.KidRefreshToken,
        "KidUrlBasePath": data.KidUrlBasePath,
        "LocationCode": data.LocationCode
    });
});

app.post('/api/ReturnMyOculusHashV2', async (req, res) => {
    await handlePlayFabFunction(req, res, "ReturnMyOculusHash");
});

app.post('/api/ReturnCurrentVersionV2', async (req, res) => {
    await handlePlayFabFunction(req, res, "ReturnCurrentVersion");
});

app.post('/api/TryDistributeCurrencyV2', async (req, res) => {
    await handlePlayFabFunction(req, res, "TryDistributeCurrency");
});

app.post('/api/BroadCastMyRoomV2', async (req, res) => {
    await handlePlayFabFunction(req, res, "BroadCastMyRoom", req.body.FunctionParameter);
});

app.post('/api/ShouldUserAutomutePlayer', (req, res) => {
    res.json({});
});

app.listen(process.env.PORT || 1416, '0.0.0.0', () => {
    console.log(`Server running`);
});

module.exports = app;
