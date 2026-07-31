from flask import Flask, request, jsonify
from datetime import datetime, timedelta, timezone
import secrets
import base64
import uuid
import json
import threading
import requests
from typing import Dict, List, Optional
from requests.adapters import HTTPAdapter, Retry
from time import time
from functools import wraps
import requests
import os
import re
import jwt
import logging
import random
import hashlib
from flask import session as flask_session
from playfab import PlayFabSettings, PlayFabServerAPI
from jose import jwt as jose_jwt
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

# ========================= CONFIGURATION =========================
class GameInfo:
    def __init__(self):
        # Replace with your actual values (from environment variables recommended)
        self.TitleId: str = "8368C"
        self.SecretKey: str = "A6FRDN5QGDRHY8D666S3FX63O515WQYKR5OJ1DEM76UU9ONA3J"
        self.ApiKey: str = "OC|1218600388005371|616b17a380a9c80a7ceae2fb4dda8251"
        self.PlayfabAuthenticationWebhook: str = "https://discord.com/api/webhooks/1531159720927432725/PpugHOL_9Qt1nszfhHeJITdZrmb35vbknNZmnOO6dGTLJqtCV7e4R__QHGZ1rqO6BDt7"
        self.QuestsWebhook: str = "https://discord.com/api/webhooks/1531159720927432725/PpugHOL_9Qt1nszfhHeJITdZrmb35vbknNZmnOO6dGTLJqtCV7e4R__QHGZ1rqO6BDt7"
        self.PhotonWebhook: str = "https://discord.com/api/webhooks/1531159720927432725/PpugHOL_9Qt1nszfhHeJITdZrmb35vbknNZmnOO6dGTLJqtCV7e4R__QHGZ1rqO6BDt7"

    def get_auth_headers(self):
        return {"content-type": "application/json", "X-SecretKey": self.SecretKey}

settings = GameInfo()
app = Flask(__name__)
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# ========================= GLOBAL DATA =========================
pending_nonces = {}          # for mothership auth
playfab_cache = {}
mute_cache = {}
polls = [ 
    {"id": 1, "question": "ARE YOU IN THE DISCORD?", "options": ["YES", "NO"], "votes": [0, 0], "predictions": [0, 0], "active": True},
    {"id": 2, "question": "PREVIOUS VOTE", "options": ["YES", "NO"], "votes": [999, 999], "predictions": [111, 111], "active": False}
]

Quests = {
    "AllActiveQuests": {
        "DailyQuests": [ ... ],   # truncated for brevity – keep the full dict from second file
        "WeeklyQuests": [ ... ]
    }
}
# (Full quests dictionary is assumed to be pasted here; for space I'm omitting but you must include it)

PlayFabSettings.TitleId = settings.TitleId
PlayFabSettings.DeveloperSecretKey = settings.SecretKey
PlayFabSettings.UseSynchronousCallbacks = True

# ========================= KEY PAIR FOR MOTHERSHIP =========================
PRIVATE_KEY_FILE = "mothership_private.pem"
PUBLIC_KEY_FILE = "mothership_public.pem"

private_key_pem = os.environ.get('MOTHERSHIP_PRIVATE_KEY')
if not private_key_pem:
    raise RuntimeError("MOTHERSHIP_PRIVATE_KEY environment variable not set")

MOTHERSHIP_SECRET = serialization.load_pem_private_key(
    private_key_pem.encode(),
    password=None,
    backend=default_backend()
)

ALLOWED_PACKAGE_IDS = ["com.KattyZ3nStudio.DreamTaggers"]   # replace with your app's package id


# ---------- Persistent Session with Connection Pooling ----------
session = requests.Session()
app.start_time = time()
app.secret_key = 'your-secure-key2'
retries = Retry(total=2, backoff_factor=0.1, status_forcelist=[500, 502, 503, 504])
session.mount('https://', HTTPAdapter(pool_connections=50, pool_maxsize=50, max_retries=retries))
session.mount('http://', HTTPAdapter(pool_connections=50, pool_maxsize=50, max_retries=retries))

# ---------- Non-blocking Webhook Sender ----------
def _send_webhook_async(url, payload):
    try:
        session.post(url, json=payload, timeout=3)
    except Exception:
        pass   # fail silently – do not block authentication

def send_webhook_async(url, payload):
    thread = threading.Thread(target=_send_webhook_async, args=(url, payload))
    thread.daemon = True
    thread.start()

# ---------- TTL Cache for User Info (to speed up /api/photon) ----------
class TTLCache:
    def __init__(self, ttl_seconds=60):
        self.ttl = ttl_seconds
        self.cache = {}
    def get(self, key):
        entry = self.cache.get(key)
        if entry and time() - entry['time'] < self.ttl:
            return entry['value']
        return None
    def set(self, key, value):
        self.cache[key] = {'value': value, 'time': time()}

user_info_cache = TTLCache(ttl_seconds=60)

def get_cached_user_info(playfab_id):
    """Fetch UserAccountInfo from PlayFab with caching."""
    cached = user_info_cache.get(playfab_id)
    if cached:
        return cached
    resp = session.post(
        url=f"https://{settings.TitleId}.playfabapi.com/Server/GetUserAccountInfo",
        json={"PlayFabId": playfab_id},
        headers=settings.get_auth_headers(),
        timeout=5
    )
    if resp.status_code == 200:
        data = resp.json().get("data", {}).get("UserAccountInfo", {})
        user_info_cache.set(playfab_id, data)
        return data
    return None

# ========================= HELPER FUNCTIONS =========================

# GitHub codes raw URL for redeem codes
CODES_GITHUB_URL = "https://github.com/redapplegtag/backendsfrr/raw/main/codes.txt"

# Sample item IDs for code redemption
REDEEMABLE_ITEMS = ["cosmetic1", "cosmetic2", "cosmetic3", "bundle1", "skin1", "hat1", "gloves1"]

# Utility function for input validation
def validate_input(data: Dict, required_fields: List[str]) -> Optional[List[str]]:
    return [field for field in required_fields if not data.get(field)]

# Utility function for generating unique session IDs
def generate_session_id() -> str:
    return str(uuid.uuid4())

# Utility function for returning CloudScript results
def return_function_json(funcname: str, funcparam: Dict = {}, playfab_id: Optional[str] = None):
    logger.info(f"Calling function: {funcname} with parameters: {funcparam} for player {playfab_id}")
    req = requests.post(
        url=f"https://{settings.TitleId}.playfabapi.com/Server/ExecuteCloudScript",
        json={
            "PlayFabId": playfab_id,
            "FunctionName": funcname,
            "FunctionParameter": funcparam
        },
        headers=settings.get_auth_headers()
    )
    if req.status_code == 200:
        result = req.json().get("data", {}).get("FunctionResult", {})
        logger.info(f"Function result: {result}")
        return jsonify(result), req.status_code
    else:
        logger.error(f"Function execution failed, status code: {req.status_code}")
        return jsonify({}), req.status_code


def log(msg):
    print(msg)

def GetIsNonceValid(nonce: str, oculusId: str):
    try:
        req = requests.post(
            url=f'https://graph.oculus.com/user_nonce_validate?nonce={nonce}&user_id={oculusId}&access_token={settings.ApiKey}',
            headers={"content-type": "application/json"}
        )

    except Exception as e:
        print("photon nonce failed because of:", e)
        return None, str(e)
    return req.json().get("is_valid")

def ReturnFunctionJson(data, funcname, funcparam={}):
    user_id = data.get("FunctionParameter", {}).get("CallerEntityProfile", {}).get("Lineage", {}).get("TitlePlayerAccountId")
    if not user_id:
        # fallback for second file's style
        rjson = data.get("FunctionParameter", {})
        user_id = rjson.get("CallerEntityProfile", {}).get("Lineage", {}).get("TitlePlayerAccountId")
    req = requests.post(
        url=f"https://{settings.TitleId}.playfabapi.com/Server/ExecuteCloudScript",
        json={"PlayFabId": user_id, "FunctionName": funcname, "FunctionParameter": funcparam},
        headers=settings.get_auth_headers()
    )
    if req.status_code == 200:
        result = req.json().get("data", {}).get("FunctionResult", {})
        return jsonify(result), req.status_code
    else:
        return jsonify({}), req.status_code

def send_webhook(title, claims, user_id, mothership_id=None, expiration=None, error=None, color=3447003):
    try:
        desc = f"**User ID:** {user_id}\n"
        if mothership_id:
            desc += f"**Mothership ID:** {mothership_id}\n"
        if expiration:
            desc += f"**Expiration:** {expiration.isoformat()}\n"
        if error:
            desc += f"**Error:** {error}\n"
        claims_text = json.dumps(claims, indent=2)
        requests.post(settings.PlayfabAuthenticationWebhook, json={
            "embeds": [{
                "title": title,
                "description": desc + f"\n```json\n{claims_text}\n```",
                "color": color,
                "footer": {"text": "MOTHERSHIP SHIT"}
            }]
        }, timeout=5)
    except Exception as e:
        print("Webhook send failed:", e)

def send_auth_notification(playfab_id, ip, username, oculus_id):
    embed = {
        "title": "🔐 User Authenticated",
        "description": f"**{username}** just logged in!",
        "color": 0x00ffcc,
        "fields": [
            {"name": "👤 Username", "value": username, "inline": True},
            {"name": "🆔 PlayFab ID", "value": playfab_id, "inline": True},
            {"name": "🌐 IP Address", "value": ip, "inline": True},
            {"name": "🕶️ Oculus ID", "value": oculus_id, "inline": False}
        ],
        "footer": {"text": "Notification System"},
    }
    try:
        requests.post(settings.PlayfabAuthenticationWebhook, json={"embeds": [embed]})
    except Exception as e:
        print(f"Failed to send webhook: {e}")

def send_quest_notification(playfab_id, ip, username, quest_name):
    embed = {
        "title": "🎯 Quest Completed!",
        "description": f"**{username}** just completed a quest! 🔥",
        "color": 0x00ffcc,
        "fields": [
            {"name": "👤 Username", "value": username, "inline": True},
            {"name": "🆔 PlayFab ID", "value": playfab_id, "inline": True},
            {"name": "🌐 IP Address", "value": ip, "inline": True},
            {"name": "🏆 Quest", "value": quest_name, "inline": False}
        ],
        "footer": {"text": "Quest Notification System"},
    }
    try:
        requests.post(settings.QuestsWebhook, json={"embeds": [embed]})
    except Exception as e:
        print(f"Failed to send webhook: {e}")

def send_photon_notification(user_id, ip, nickname, platform):
    embed = {
        "title": "🔌 Photon Authentication",
        "description": f"**{nickname}** just authenticated via Photon!",
        "color": 0x3498db,
        "fields": [
            {"name": "👤 Username", "value": nickname or "Unknown", "inline": True},
            {"name": "🆔 PlayFab ID", "value": user_id or "Unknown", "inline": True},
            {"name": "🌐 IP Address", "value": ip or "Unknown", "inline": True},
            {"name": "📱 Platform", "value": platform or "Unknown", "inline": False}
        ],
        "footer": {"text": "Photon Authentication System"},
    }
    try:
        requests.post(settings.PhotonWebhook, json={"embeds": [embed]})
    except Exception as e:
        print(f"Webhook failed: {e}")

def validate_oculus_nonce(nonce):
    """
    Validates an Oculus nonce.
    Returns (app_scoped_user_id, None) on success,
    or (None, error_message) on failure.
    """
    app_access_token = "1170114982854947|1189e3afc105a971fd888f8d3fb858a2"
    url = "https://graph.oculus.com/user_nonce_validation"
    params = {
        "nonce": nonce,
        "access_token": app_access_token
    }

    try:
        resp = requests.get(url, params=params, timeout=5)
        resp.raise_for_status()
        data = resp.json()

        if data.get("is_valid") and "id" in data:
            return data["id"], None
        else:
            # Sometimes the API returns an error field
            error_msg = data.get("error", {}).get("message", "Invalid nonce response")
            return None, error_msg

    except requests.exceptions.RequestException as e:
        logging.error(f"Oculus nonce validation request failed: {e}")
        return None, str(e)
        
def get_oculus_id_from_nonce(nonce):
    """Validate the nonce with Oculus and return the numeric User ID."""
    # Oculus requires the App Access Token to validate a nonce
    app_access_token = settings.ApiKey
    
    try:
        resp = requests.get(
            f"https://graph.oculus.com/user_info",
            params={
                "nonce": nonce,
                "access_token": app_access_token
            },
            timeout=5
        )
        
        if resp.status_code == 200:
            data = resp.json()
            oculus_id = data.get("id")  # This is the numeric string you need
            if oculus_id:
                logging.info(f"Oculus nonce validated, ID: {oculus_id}")
                return oculus_id
        else:
            logging.error(f"Oculus Graph API error: {resp.status_code} - {resp.text}")
            
    except Exception as e:
        logging.error(f"Failed to call Oculus Graph API: {e}")
    
    return None

def get_oculus_id_from_playfab(playfab_id):
    """Retrieve linked Oculus ID using direct HTTP call to PlayFab."""
    try:
        resp = session.post(
            url=f"https://{settings.TitleId}.playfabapi.com/Server/GetUserAccountInfo",
            json={"PlayFabId": playfab_id},
            headers=settings.get_auth_headers(),
            timeout=5
        )
        if resp.status_code != 200:
            logging.error(f"GetUserAccountInfo failed: {resp.status_code} {resp.text}")
            return None

        # PlayFab HTTP API wraps result in "data"
        data = resp.json().get("data", {})
        account_info = data.get("UserAccountInfo", {})
        oculus_info = account_info.get("OculusInfo")
        if not oculus_info:
            logging.warning(f"No OculusInfo found for {playfab_id}")
            return None

        raw_id = oculus_info.get("OculusId")
        if not raw_id:
            logging.warning(f"OculusInfo missing OculusId for {playfab_id}")
            return None

        numeric_id = extract_numeric_oculus_id(raw_id)
        if numeric_id:
            logging.info(f"Extracted numeric Oculus ID {numeric_id} from {raw_id}")
        return numeric_id

    except Exception as e:
        logging.error(f"Failed to get Oculus ID for {playfab_id}: {e}")
        return None


def validate_and_store_oculus(player_id, oculus_id, nonce):
    """Store data and call CloudScript using direct HTTP calls."""
    # 1. Update internal data
    try:
        resp = session.post(
            url=f"https://{settings.TitleId}.playfabapi.com/Server/UpdateUserInternalData",
            json={
                "PlayFabId": player_id,
                "Data": {
                    "OculusId": oculus_id,
                    "OculusNonce": nonce
                }
            },
            headers=settings.get_auth_headers(),
            timeout=5
        )
        if resp.status_code != 200:
            logging.error(f"UpdateUserInternalData failed: {resp.status_code} {resp.text}")
            return False, None
    except Exception as e:
        logging.error(f"Failed to store Oculus data: {e}")
        return False, None

    # 2. Execute CloudScript
    try:
        resp = session.post(
            url=f"https://{settings.TitleId}.playfabapi.com/Server/ExecuteCloudScript",
            json={
                "FunctionName": "ValidateNonce",
                "PlayFabId": player_id
            },
            headers=settings.get_auth_headers(),
            timeout=5
        )
        if resp.status_code != 200:
            logging.error(f"ExecuteCloudScript failed: {resp.status_code} {resp.text}")
            return False, None

        data = resp.json().get("data", {})
        function_result = data.get("FunctionResult", {})
        return True, function_result.get("result")

    except Exception as e:
        logging.error(f"CloudScript execution failed: {e}")
        return False, None

# For the nickname retrieval, you can reuse your existing `get_cached_user_info`
# (or call the same endpoint without caching). Example:
def fetch_nickname(playfab_id):
    """Fetch nickname directly via HTTP if not cached."""
    try:
        resp = session.post(
            url=f"https://{settings.TitleId}.playfabapi.com/Server/GetUserAccountInfo",
            json={"PlayFabId": playfab_id},
            headers=settings.get_auth_headers(),
            timeout=5
        )
        if resp.status_code == 200:
            data = resp.json().get("data", {}).get("UserAccountInfo", {})
            return data.get("Username")
    except Exception as e:
        logging.error(f"Failed to fetch user info: {e}")
    return None

def store_oculus_id_in_playfab(playfab_id, oculus_id):
    try:
        session.post(
            url=f"https://{settings.TitleId}.playfabapi.com/Server/UpdateUserInternalData",
            json={
                "PlayFabId": playfab_id,
                "Data": {
                    "OculusId": oculus_id
                }
            },
            headers=settings.get_auth_headers(),
            timeout=5
        )
    except Exception as e:
        logging.warning(f"Could not store OculusId: {e}")

def get_oculus_id_from_playfab(playfab_id):
    try:
        resp = session.post(
            url=f"https://{settings.TitleId}.playfabapi.com/Server/GetUserInternalData",
            json={"PlayFabId": playfab_id, "Keys": ["OculusId"]},
            headers=settings.get_auth_headers(),
            timeout=5
        )
        if resp.status_code == 200:
            data = resp.json().get('data', {}).get('Data', {})
            oculus_id = data.get('OculusId', {}).get('Value')
            return oculus_id
    except Exception:
        pass
    return None

# ========================= ROUTES =========================
@app.route("/", methods=["POST", "GET"])
def main():
    return """
        <html>
            <head><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet"></head>
            <body style="font-family: 'Inter', sans-serif;">
                <h1 style="color: green; font-size: 30px;">SIEGMAAA Backend is up and Running!</h1>
            </body>
        </html>
    """

# -------------------- Mothership Authentication --------------------
@app.route('/v2/player/client/auth/begin/QUEST', methods=['POST'])
def auth_begin():
    data = request.get_json(silent=True) or {}
    user_id = data.get("UserId")
    if not user_id:
        return jsonify({"error": "no UserId"}), 400
    nonce_bytes = secrets.token_bytes(64)
    nonce_b64 = base64.urlsafe_b64encode(nonce_bytes).decode('utf-8').rstrip("=")
    pending_nonces[user_id] = nonce_b64
    return jsonify({"AttestationNonce": nonce_b64}), 201

@app.route('/v2/player/client/auth/complete/QUEST', methods=['POST'])
def auth_complete():
    rjson = request.get_json(silent=True) or {}
    user_id = rjson.get("UserId")
    attestation_token = rjson.get("AttestationToken")
    expected_nonce = pending_nonces.get(user_id)
    statusCode = 401
    if not user_id or not attestation_token or not expected_nonce:
        return jsonify({
            "message": '{"MothershipErrorCode":10013,"ClientMessage":"Client Authentication Failed","TraceId":"' + str(uuid.uuid4()) + '"}',
            "statusCode": statusCode
        }), statusCode
    try:
        META_ACCESS_TOKENS = [settings.ApiKey]   # Use your API key(s)
        claims = None
        last_error = None
        for meta_token in META_ACCESS_TOKENS:
            try:
                verify_url = f"https://graph.oculus.com/platform_integrity/verify?token={attestation_token}&access_token={meta_token}"
                r = requests.get(verify_url, timeout=5)
                r.raise_for_status()
                result = r.json()
                if result['data'][0].get('message') == 'success' and result['data'][0].get('claims'):
                    claims_b64 = result['data'][0]['claims']
                    claims_json = base64.urlsafe_b64decode(claims_b64 + '=' * (-len(claims_b64) % 4)).decode()
                    claims = json.loads(claims_json)
                    break
            except Exception as e:
                last_error = e
                continue
        if not claims:
            raise ValueError(f"Attestation failed: {last_error}")
        token_nonce = claims['request_details'].get('nonce')
        if token_nonce != expected_nonce:
            raise ValueError("Nonce mismatch")
        app_state = claims.get("app_state", {})
        device_state = claims.get("device_state", {})
        if (app_state.get("app_integrity_state") != "StoreRecognized" or
            device_state.get("device_integrity_state") != "Advanced" or
            app_state.get("package_id") not in ALLOWED_PACKAGE_IDS):
            send_webhook("⚠️ - Mothership Failed", claims, user_id=user_id,
                error=f"Integrity check failed: {app_state.get('package_id')}", color=15158332)
            return "", statusCode
        del pending_nonces[user_id]
        mothership_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, user_id))
        expiration = datetime.now(timezone.utc) + timedelta(hours=1)
        payload = {
            "sub": user_id,
            "did": app_state.get('package_id'),
            "env": app_state.get('version', '1'),
            "externalService": "QUEST",
            "externalServiceId": app_state.get('package_id', ''),
            "tid": str(uuid.uuid4())[:8],
            "tags": None,
            "orgScopedExternalServiceId": str(uuid.uuid4())[:8],
            "nbf": int(datetime.now(timezone.utc).timestamp()),
            "exp": int(expiration.timestamp()),
            "iat": int(datetime.now(timezone.utc).timestamp())
        }
        mothership_token = jwt.encode(payload, MOTHERSHIP_SECRET, algorithm='ES256')
        send_webhook("✅ - Mothership Success", claims, user_id=user_id,
            mothership_id=mothership_id, expiration=expiration, color=3066993)
        return jsonify({
            "MothershipToken": mothership_token,
            "MothershipId": mothership_id,
            "ExpirationTime": int(expiration.timestamp() * 1000),
            "ExternalProviderId": user_id,
            "ExternalProviderUsername": "",
            "IsPrimaryId": True,
            "PlayerId": user_id,
            "Tags": None,
            "Token": mothership_token
        }), 200
    except Exception as e:
        print("Attestation failed:", e)
        send_webhook("❌ - Mothership Error", {}, user_id, error=str(e), color=15105570)
        return jsonify({
            "message": '{"MothershipErrorCode":10013,"ClientMessage":"Client Authentication Failed","TraceId":"' + str(uuid.uuid4()) + '"}',
            "statusCode": statusCode
        }), statusCode

# -------------------- PlayFab Authentication --------------------
@app.route("/api/PlayFabAuthentication", methods=["POST"])
def playfab_authentication():
    if request.method == "GET":
        return jsonify({"error": "GET method not supported. Use POST."}), 405

    data = request.get_json()
    if not data or "OculusId" not in data:
        return jsonify({"error": "Missing OculusId"}), 400

    oculus_id = data["OculusId"]
    ip = request.remote_addr

    # 1. Login with persistent session
    login_req = session.post(
        url=f"https://{settings.TitleId}.playfabapi.com/Server/LoginWithServerCustomId",
        json={"ServerCustomId": f"OCULUS{oculus_id}", "CreateAccount": True},
        headers=settings.get_auth_headers(),
        timeout=5
    )

    if login_req.status_code != 200:
        ban_info = login_req.json()
        if ban_info.get("errorCode") == 1002:
            ban_details = ban_info.get("errorDetails", {})
            ban_expiration_key = next(iter(ban_details.keys()), None)
            ban_expiration = ban_details.get(ban_expiration_key, ["Indefinite"])[0]
            return jsonify({"BanMessage": ban_expiration_key, "BanExpirationTime": ban_expiration}), 403
        return jsonify({"error": "PlayFab login failed", "details": ban_info.get("errorMessage", "Unknown error")}), login_req.status_code

    rjson = login_req.json().get('data', {})
    session_ticket = rjson.get('SessionTicket')
    playfab_id = rjson.get('PlayFabId')
    entity = rjson.get('EntityToken', {})
    entity_token = entity.get('EntityToken')
    entity_id = entity.get('Entity', {}).get('Id')
    entity_type = entity.get('Entity', {}).get('Type')
    kid_access_token = rjson.get('KidAccessToken')
    kid_refresh_token = rjson.get('KidRefreshToken')
    kid_url_base_path = rjson.get('KidUrlBasePath')
    location_code = rjson.get('LocationCode')

    store_oculus_id_in_playfab(playfab_id, oculus_id)

    # 2. Fire-and-forget: send webhook and link custom ID (do NOT block response)
    def background_tasks():
        # Discord notification
        embed = {
            "title": "🔐 User Authenticated",
            "description": f"**Oculus_{oculus_id}** just logged in!",
            "color": 0x00ffcc,
            "fields": [
                {"name": "PlayFab ID", "value": playfab_id, "inline": True},
                {"name": "IP", "value": ip, "inline": True}
            ]
        }
        send_webhook_async(settings.PlayfabAuthenticationWebhook, {"embeds": [embed]})

        # Link Custom ID (optional, not needed for the response)
        try:
            session.post(
                url=f"https://{settings.TitleId}.playfabapi.com/Client/LinkCustomID",
                json={"CustomID": f"OCULUS{oculus_id}", "ForceLink": True},
                headers={"content-type": "application/json", "x-authorization": session_ticket},
                timeout=3
            )
        except Exception:
            pass

    threading.Thread(target=background_tasks, daemon=True).start()

    # 3. Return immediately – no waiting for webhook or link
    return jsonify({
        "SessionTicket": session_ticket,
        "EntityToken": entity_token,
        "PlayFabId": playfab_id,
        "EntityId": entity_id,
        "EntityType": entity_type,
        "KidAccessToken": kid_access_token,
        "KidRefreshToken": kid_refresh_token,
        "KidUrlBasePath": kid_url_base_path,
        "LocationCode": location_code
    }), 200
@app.route("/api/PlayFabAuthentication/test", methods=["GET"])
def test_auth_notification():
    send_auth_notification("AUTH12345", "127.0.0.1", "TestAuthUser", "1234567890")
    return jsonify({"status": "Test auth notification sent!"}), 200

# -------------------- Title Data --------------------
@app.route("/v1/title-data/client", methods=["POST", "GET"])
@app.route('/api/TD', methods=['POST', 'GET'])
@app.route('/api/TitleData', methods=['POST', 'GET'])
def title_data():
    response = requests.post(
        url=f"https://{settings.TitleId}.playfabapi.com/Server/GetTitleData",
        headers=settings.get_auth_headers()
    )
    if response.status_code == 200:
        return jsonify(response.json().get("data", {}).get("Data", {}))
    else:
        return jsonify({}), response.status_code

# -------------------- Cache PlayFab ID --------------------
@app.route("/api/CachePlayFabId", methods=["GET", "POST"])
def cacheplayfabid():
    data = request.get_json()
    if not data:
        return jsonify({"Message": "Success"}), 200
    # second file expects specific fields; we return them
    return jsonify({
        "Message": "Yay Your Authed",
        "PlayFabId": data.get("PlayFabId"),
        "KidAccessToken": data.get("KidAccessToken"),
        "KidRefreshToken": data.get("KidRefreshToken"),
        "KidUrlBasePath": data.get("KidUrlBasePath"),
        "LocationCode": data.get("LocationCode")
    }), 200

# -------------------- IAP --------------------
@app.route("/api/ConsumeOculusIAP", methods=["POST"])
def consume_oculus_iap():
    rjson = request.get_json()
    access_token = rjson.get("userToken")
    user_id = rjson.get("userID")
    nonce = rjson.get("nonce")
    sku = rjson.get("sku")
    response = requests.post(
        url=f"https://graph.oculus.com/consume_entitlement?nonce={nonce}&user_id={user_id}&sku={sku}&access_token={settings.ApiKey}",
        headers={"content-type": "application/json"}
    )
    if response.json().get("success"):
        return jsonify({"result": True})
    else:
        return jsonify({"error": True})

# -------------------- Photon Authentication --------------------
@app.route("/api/photon", methods=["POST", "GET"])
def photonauth():
    print(f"Received {request.method} request at /api/photon")

    # Parse input based on method
    if request.method == 'GET':
        Ticket = request.args.get("Ticket")
        Nonce = request.args.get("Nonce")
        Platform = request.args.get("Platform")
        UserId = request.args.get("UserId")
        nickName = request.args.get("username")
    else:  # POST
        getjson = request.get_json()
        if not getjson:
            print("Headers:", dict(request.headers))
            print("Raw body:", request.data)
            print("JSON:", request.get_json(silent=True))
            return jsonify({'error': 'Missing JSON body'}), 400
        Ticket = getjson.get("Ticket")
        Nonce = getjson.get("Nonce")
        Platform = getjson.get("Platform")
        UserId = getjson.get("UserId")
        nickName = getjson.get("username")

    ip = request.remote_addr

    # Determine PlayFab ID
    playfab_id = UserId
    if not playfab_id and Ticket:
        playfab_id = Ticket.split('-')[0]
    if not playfab_id or len(playfab_id) != 16:
        return jsonify({'resultCode': 2, 'message': 'Invalid token', 'userId': None, 'nickname': None})

    OculusId = get_oculus_id_from_playfab(playfab_id)
    if not OculusId:
        return jsonify({"error": "Not logged in"}), 401

    # Oculus Validation for Quest
    if not Nonce or not OculusId:
        print("Headers:", dict(request.headers))
        print("Raw body:", request.data)
        print("JSON:", getjson)
        return jsonify({'Error': 'Missing Nonce or OculusId'}), 400

    # Optionally store the validated OculusId in PlayFab Internal Data for caching
    try:
        session.post(
            url=f"https://{settings.TitleId}.playfabapi.com/Server/UpdateUserInternalData",
            json={
                "PlayFabId": playfab_id,
                "Data": {
                    "OculusId": OculusId,
                    "OculusNonce": Nonce
                }
            },
            headers=settings.get_auth_headers(),
            timeout=5
        )
    except Exception as e:
        logging.warning(f"Could not store Oculus data: {e}")
    
    # Nickname fetching
    if not nickName:
        nickName = fetch_nickname(playfab_id)

    send_photon_notification(playfab_id, ip, nickName, Platform)

    return jsonify({
        'resultCode': 1,
        'message': f'Authenticated user {playfab_id.lower()} title {PlayFabSettings.TitleId.lower()}',
        'userId': playfab_id.upper(),
        'nickname': nickName
    })

@app.route("/api/photon/test", methods=["GET"])
def test_photon_notification():
    send_photon_notification("TESTUSERID123456", request.remote_addr, "TestUser", "Quest")
    return jsonify({"status": "Test photon notification sent!"}), 200

# -------------------- Additional Endpoints from First File --------------------
@app.route("/v1/userdata/client", methods=["POST", "GET"])
def userdata_client():
    return jsonify("Userdata Client")

@app.route("/api/GetTier", methods=["POST", "GET"])
def get_tier():
    return jsonify("Get Tier")

@app.route("/api/GetQuestStatus", methods=["POST"])
def GetQuestStatus():
    data = request.json
    playfab_id = data.get("playfab_id", "UNKNOWN_ID")
    ip = request.remote_addr
    username = data.get("username", "UnknownUser")
    quest_name = data.get("quest_name", "Unknown Quest")
    send_quest_notification(playfab_id, ip, username, quest_name)
    if playfab_id in ["13DAE985991634E2"]:
        return jsonify({"result": {"dailyPoints": {}, "weeklyPoints": {}, "userPointsTotal": 99999}, "statusCode": 200, "error": None})
    return jsonify({"result": {"dailyPoints": {}, "weeklyPoints": {}, "userPointsTotal": 0}, "statusCode": 200, "error": None})

@app.route("/api/GetQuestStatus/test", methods=["GET"])
def test_quest_notification():
    send_quest_notification("TEST12345", "127.0.0.1", "TestUser", "🏄‍♂️ RIDE THE SHARK")
    return jsonify({"status": "Test notification sent!"}), 200

@app.route("/api/GetProgression", methods=["POST", "GET"])
def get_progression():
    return jsonify("Get Progression")

@app.route("/api/GetShiftCredit", methods=["POST", "GET"])
def get_shift_credit():
    return jsonify("Get Shift Credit")

@app.route("/api/GetActiveSIQuests", methods=["POST", "GET"])
def get_active_si_quests():
    return jsonify("Get Active SI Quests")

@app.route("/v1/client/analytics/event/batch", methods=["POST"])
def analytics():
    rjson = request.get_json(silent=True) or {}
    event_ids = []
    for event in rjson.get("Events", []):
        resp = requests.post(
            f"https://{settings.TitleId}.playfabapi.com/Server/WritePlayerEvent",
            headers=settings.get_auth_headers(),
            json={
                "EventName": event.get("EventName"),
                "Timestamp": event.get("EventTimestamp"),
                "Body": event.get("Body"),
                "CustomTags": event.get("CustomTags"),
                "PlayFabId": rjson.get("PlayFabId")
            }
        )
        ev_id = resp.json()
        event_ids.append({"EventId": ev_id.get("data", {}).get("EventId")} if ev_id.get("data") else {"EventId": None})
    return jsonify(event_ids)

# -------------------- Other Additional Endpoints --------------------
@app.route("/api/GetFriendsV2", methods=['POST'])
def get_friends_v2():
    return jsonify({"result":{"friends":[{"presence":{"friendLinkId":"YES","userName":"userName","roomId":"roomId","zone":"zone","region":"region","isPublic":True},"created":"2001-09-11T08:46:01.713"}],"myPrivacyState":0},"statusCode":200,"error":None})

@app.route('/api/AddOrRemoveDLCOwnership', methods=['POST', 'GET'])
def AddOrRemoveDLCOwnership():
    data = request.json
    PlayFabId = data['CallerEntityProfile']['Lineage']['MasterPlayerAccountId']
    return jsonify(True)

@app.route("/api/GetRandomName", methods=["POST", "GET"])
def get_random_name():
    return jsonify({"result": f"gorilla{random.randint(1000, 9999)}"})

@app.route('/api/GetName', methods=['POST', 'GET'])
def GetName():
    return jsonify({"result": f"GORILLA{random.randint(1000,9999)}"})

@app.route("/api/FetchPoll", methods=["POST"]) 
def fetch_poll_ig():
    logger.info("[POLL] Fetch polls request")
    return jsonify(polls), 200

@app.route("/api/TryDistributeCurrencyV2", methods=["POST"])
def TryDistributeCurrencyV2():
    if request.method != "POST":
        return "", 404
        
    rjson = request.json
    sr_a_day = 100
    current_player_id = rjson.get("CallerEntityProfile", {}).get("Lineage", {}).get("MasterPlayerAccountId")

    get_data_response = requests.post(
        f"https://{settings.TitleId}.playfabapi.com/Server/GetUserReadOnlyData",
        headers=settings.get_auth_headers(),
        json={
            "PlayFabId": current_player_id,
            "Keys": ["DailyLogin"]
        }
    )

    daily_login_value = get_data_response.json().get("data").get("Data").get("DailyLogin", {}).get("Value", None)

    last_login_date = None
    if daily_login_value:
        last_login_date = datetime.fromisoformat(daily_login_value.replace("Z", "+00:00")).astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    if not last_login_date or last_login_date < datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc):
        requests.post(
            f"https://{settings.TitleId}.playfabapi.com/Server/AddUserVirtualCurrency",
            headers=settings.get_auth_headers(),
            json={
                "PlayFabId": current_player_id,
                "VirtualCurrency": "SR",
                "Amount": sr_a_day
            }
        )

        requests.post(
            f"https://{settings.TitleId}.playfabapi.com/Server/UpdateUserReadOnlyData",
            headers=settings.get_auth_headers(),
            json={
                "PlayFabId": current_player_id,
                "Data": {
                    "DailyLogin": datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc).isoformat()
                }
            }
        )

    return "", 200

@app.route("/api/ReturnMyOculusHashV2", methods=["POST"])
def ReturnMyOculusHashV2():
    if request.method != "POST":
        return "", 404

    response = requests.post(
        f"https://{settings.TitleId}.playfabapi.com/Server/GetUserAccountInfo",
        headers=settings.get_auth_headers(),
        json={"PlayFabId": request.json["CallerEntityProfile"]["Lineage"]["MasterPlayerAccountId"]}
    )
    
    if response.status_code == 200:
        return jsonify({
            "oculusHash": hashlib.sha256(response.json()["data"]["UserInfo"]["ServerCustomIdInfo"]["CustomId"].replace("OCULUS", "").encode('utf-8')).hexdigest(),
            "error": False
        }), 200
    
    return jsonify({"error": True}), 200

@app.route("/api/Vote", methods=["POST"])
def Luckys_VoteApi():
    VOTING_WEBHOOK = "https://discord.com/api/webhooks/1530187975579795569/VijgiNO28wGKbYnMxxV6XXVuN3cbCEoMTe_ey_IDlTotCMNUJpuGUoQlHvKbwR2RSS26"  # Your voting webhook

    get = request.get_json()

    PollId = get.get("PollId")
    TitleId = get.get("TitleId")
    PlayFabId = get.get("PlayFabId")
    OculusId = get.get("OculusId")
    UserNonce = get.get("UserNonce")
    UserPlatform = get.get("UserPlatform")
    OptionIndex = get.get("OptionIndex")
    IsPrediction = get.get("IsPrediction")
    PlayFabTicket = get.get("PlayFabTicket")
    AppVersion = get.get("AppVersion")

    if get is None:
        return jsonify({"Message": "Something Happened"}), 400

    find = next((p for p in poll_shit if p["PollId"] == PollId), None)

    if not find:
        return jsonify({"Message": "Poll not found"}), 404

    embed = {
        "embeds": [
            {
                "title": "** A PLAYER HAS VOTED 📝 **",
                "description": (
                    "\n\n**↓ Vote Details ↓**\n\n"
                    "```"
                    f"VOTE QUESTION: {find['Question']}\n"
                    f"VOTING FOR: {find['VoteOptions'][OptionIndex]}\n"
                    f"PREDICTION: {str(IsPrediction)}\n"
                    f"PollId: {str(PollId)}\n"
                    "```\n\n"
                    "**↓ Player Details ↓**\n\n"
                    "```"
                    f"USER ID: {str(PlayFabId)}\n"
                    f"OCULUS ID: {str(OculusId)}\n"
                    f"PLATFORM: {str(UserPlatform)}\n"
                    f"PlayFabTicket: {str(PlayFabTicket)}\n"
                    f"NONCE: {str(UserNonce)}\n"
                    f"APPVERSION: {str(AppVersion)}"
                    "```"
                ),
                "color": 63488
            }
        ]
    }

    requests.post(url=VOTING_WEBHOOK, json=embed)

    return jsonify({"Message": "Yay Votes Are Fixed, Very Cool"}), 200

@app.route("/api/SubmitVote", methods=["POST"]) 
def submit_vote():
    payload = request.get_json() or {}
    poll_id = payload.get("PollId")
    user = payload.get("PlayFabId")
    choice = payload.get("OptionIndex")
    prediction = payload.get("IsPrediction")

    poll = next((p for p in polls if p["id"] == poll_id), None)
    if not poll or not poll["active"] or choice not in range(len(poll["options"])):
        logger.error("[POLL] Invalid vote attempt: poll %s, choice %s", poll_id, choice)
        return jsonify({"status": "error", "message": "Invalid poll or option."}), 400

    key = "predictions" if prediction else "votes"
    poll[key][choice] += 1
    logger.info("[POLL] Updated %s for user %s on poll %s", key, user, poll_id)

    return jsonify({
        "status": "success",
        "pollId": poll_id,
        "option": poll["options"][choice],
        "newCount": poll[key][choice]
    }), 200

@app.route("/api/GetAcceptedAgreements", methods=["POST", "GET"])
def get_accepted_agreements():
    rjson = request.get_json()["FunctionResult"]
    return jsonify(rjson)

@app.route("/api/SubmitAcceptedAgreements", methods=["POST", "GET"])
def submit_accepted_agreements():
    rjson = request.get_json()["FunctionResult"]
    return jsonify(rjson)

@app.route("/api/validate_user", methods=['POST'])
def validate_user():
    data = request.json
    if not data or 'custom_id' not in data:
        return jsonify({"error": "Missing 'custom_id' in request."}), 400
    custom_id = data['custom_id']
    auth_response = requests.post(
        f"https://{settings.TitleId}.playfabapi.com/Client/LoginWithCustomID",
        json={"CustomId": custom_id, "CreateAccount": True, "TitleId": settings.TitleId}
    )
    if auth_response.status_code != 200:
        return jsonify({"error": "Failed to authenticate user."}), 500
    auth_data = auth_response.json()
    if "error" in auth_data:
        return jsonify({"error": auth_data["error"]}), 500
    user_id = auth_data['data']['PlayFabId']
    if not (custom_id.startswith("OCULUS") and custom_id[16:].isdigit()):
        ban_response = requests.post(
            f"https://{settings.TitleId}.playfabapi.com/Admin/BanUsers",
            headers={"X-SecretKey": settings.SecretKey},
            json={"Bans": [{"PlayFabId": user_id, "Reason": "Invalid ID format."}]}
        )
        if ban_response.status_code != 200:
            return jsonify({"error": "Failed to ban user."}), 500
        return jsonify({"message": "User banned for invalid ID."}), 200
    return jsonify({"message": "User validated successfully.", "PlayFabId": user_id}), 200

@app.route("/api/ConsumeCodeItem", methods=["POST"])
def consume_code_item():
    rjson = request.get_json()
    code = rjson.get("itemGUID")
    playfab_id = rjson.get("playFabID")
    session_ticket = rjson.get("playFabSessionTicket")
    if not all([code, playfab_id, session_ticket]):
        return jsonify({"error": "Missing parameters"}), 400
    raw_url = ""   # URL to your codes file (GitHub raw)
    response = requests.get(raw_url)
    if response.status_code != 200:
        return jsonify({"error": "GitHub fetch failed"}), 500
    lines = response.text.splitlines()
    codes = {}
    for line in lines:
        if ":" in line:
            k, v = line.split(":", 1)
            codes[k.strip()] = v.strip()
    if code not in codes:
        return jsonify({"result": "CodeInvalid"}), 404
    if codes[code] == "AlreadyRedeemed":
        return jsonify({"result": codes[code]}), 200
    grant_response = requests.post(
        f"https://{settings.TitleId}.playfabapi.com/Admin/GrantItemsToUsers",
        json={"ItemGrants": [{"PlayFabId": playfab_id, "ItemId": "dis da cosmetics", "CatalogVersion": "DLC"}]},
        headers=settings.get_auth_headers()
    )
    if grant_response.status_code != 200:
        return jsonify({"result": "PlayFabError", "errorMessage": grant_response.json().get("errorMessage", "Grant failed")}), 500
    # Optionally update the codes file (not implemented here)
    return jsonify({"result": "Success", "itemID": code, "playFabItemName": codes[code]}), 200

@app.route("/api/UploadGorillanalytics", methods=["POST"])
def Upload_Gorillanalytics():
    data = request.json
    if not data:
        return jsonify({"error": "Invalid data"}), 400
    function_result = data.get("FunctionResult", {})
    embed = {
        "title": "New Upload Data",
        "color": 5814783,
        "fields": [
            {"name": "Version", "value": function_result.get("version", "N/A"), "inline": True},
            {"name": "Upload Chance", "value": function_result.get("upload_chance", "N/A"), "inline": True},
            {"name": "Map", "value": function_result.get("map", "N/A"), "inline": True},
            {"name": "Mode", "value": function_result.get("mode", "N/A"), "inline": True},
            {"name": "Queue", "value": function_result.get("queue", "N/A"), "inline": True},
            {"name": "Player Count", "value": str(function_result.get("player_count", "N/A")), "inline": True},
            {"name": "Position", "value": f"({function_result.get('pos_x', 'N/A')}, {function_result.get('pos_y', 'N/A')}, {function_result.get('pos_z', 'N/A')})", "inline": False},
            {"name": "Velocity", "value": f"({function_result.get('vel_x', 'N/A')}, {function_result.get('vel_y', 'N/A')}, {function_result.get('vel_z', 'N/A')})", "inline": False},
            {"name": "Cosmetics Owned", "value": function_result.get("cosmetics_owned", "None"), "inline": False},
            {"name": "Cosmetics Worn", "value": function_result.get("cosmetics_worn", "None"), "inline": False},
        ],
    }
    try:
        requests.post(settings.PlayfabAuthenticationWebhook, json={"embeds": [embed]})
        return jsonify({"status": "Success"}), 200
    except Exception:
        return jsonify({"error": "Failed to send embed"}), 500

@app.route("/api/KIDIntegration", methods=["POST"])
def k_id():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Missing JSON body"}), 400
    required_fields = ["Age", "Permissions", "GetSubmittedAge", "VoiceChat", "CustomNames", "PhotonPermission"]
    missing = [field for field in required_fields if field not in data]
    if missing:
        return jsonify({"error": f"Missing fields: {', '.join(missing)}"}), 400
    response = {
        "status": "success",
        "UserAge": data.get("Age"),
        "Permissions": data.get("Permissions"),
        "GetSubmittedAge": data.get("GetSubmittedAge"),
        "VoiceChat": data.get("VoiceChat"),
        "CustomNames": data.get("CustomNames"),
        "PhotonPermission": data.get("PhotonPermission"),
        "AnnouncementData": {
            "ShowAnnouncement": "False",
            "AnnouncementID": "kID_Prelaunch",
            "AnnouncementTitle": "IMPORTANT NEWS",
            "Message": "We're working to make Gorilla Tag a better..."
        }
    }
    return jsonify(response), 200

@app.route('/api/v2/GetName', methods=['POST', 'GET'])
def GetNameIg2():
    return jsonify({"result": f"GORILLA{random.randint(1000,9999)}"})

@app.route("/api/CheckForBadName", methods=["POST"])
def check_for_bad_name():
    rjson = request.get_json().get("FunctionResult")
    name = rjson.get("name").upper()
    bad_names = ["KKK", "PENIS", "NIGG", "NEG", "NIGA", "MONKEYSLAVE", "SLAVE", "FAG", 
                 "NAGGI", "TRANNY", "QUEER", "KYS", "DICK", "PUSSY", "VAGINA", "BIGBLACKCOCK", 
                 "DILDO", "HITLER", "KKX", "XKK", "NIGA", "NIGE", "NIG", "NI6", "PORN", 
                 "JEW", "JAXX", "KXK", "SEX", "COCK", "CUM", "FUCK", "PENIS", "DICK", 
                 "ELLIOT", "JMAN", "K9", "NIGGA", "TTTPIG", "NICKER", "NICKA", 
                 "REEL", "NII", "@here", "!", " ", "JMAN", "PPPTIG", "CLEANINGBOT", "JANITOR", "K9", 
                 "H4PKY", "MOSA", "NIGGER", "NIGGA", "IHATENIGGERS", "@everyone", "@here", "_", "-", "*", "$"]
    if name in bad_names:
        return jsonify({"result": 2})
    else:
        return jsonify({"result": 0})

@app.route("/voten/api/FetchPoll", methods=["GET", "POST"])
def fetch_poll():
    active_polls = [p for p in polls if p.get("isActive", False)]
    return jsonify(active_polls), 200

@app.route("/voten/api/Vote", methods=["POST"])
def vote():
    data = request.json
    if not data:
        return jsonify({"error": "Invalid request data"}), 400
    poll_id_str = data.get("PollId")
    playfab_id = data.get("PlayFabId")
    option_index_str = data.get("OptionIndex")
    is_prediction = data.get("IsPrediction", False)
    if not all([poll_id_str, playfab_id, option_index_str is not None]):
        return jsonify({"error": "Missing PollId, PlayFabId, or OptionIndex"}), 400
    try:
        poll_id = int(poll_id_str)
        option_index = int(option_index_str)
    except ValueError:
        return jsonify({"error": "PollId and OptionIndex must be integers"}), 400
    poll = next((p for p in polls if p["pollId"] == poll_id), None)
    if not poll:
        return jsonify({"error": "Poll not found"}), 404
    if not poll.get("isActive", False):
        return jsonify({"error": "Poll is not active"}), 403
    if not (0 <= option_index < len(poll["voteOptions"])):
        return jsonify({"error": "Invalid option index"}), 400
    # Send to Discord
    embed = {
        "embeds": [{
            "title": "✅ - Vote success",
            "description": f"**PlayFab ID**: {playfab_id}\n**Prediction**: {is_prediction}\n**Question**: {poll['question']}\n**Voting for**: {poll['voteOptions'][option_index]}",
            "color": 3447003
        }]
    }
    try:
        requests.post(settings.PlayfabAuthenticationWebhook, json=embed, timeout=5)
    except Exception as e:
        print(f"Failed to send vote to Discord: {e}")
    return jsonify({"success": True, "message": "Vote cast successfully"}), 200

@app.route("/api/FakeMothershipAuth", methods=["POST"])
def mothership_auth():
    datp = request.get_json()
    if not datp:
        return jsonify({"Error": "Bad request", "Message": "No JSON body"}), 400
    CustomId = datp.get("CustomId")
    PlayFabId_req = datp.get("PlayFabId")
    GameMode = datp.get("GameMode", "DefaultMode")
    DeviceType = datp.get("Device", "Unknown")
    Region = datp.get("Region", "global")
    if not CustomId or not PlayFabId_req:
        return jsonify({"Error": "Bad request", "Message": "Missing CustomId or PlayFabId"}), 400
    login_response = requests.post(
        url=f"https://{settings.TitleId}.playfabapi.com/Server/LoginWithServerCustomId",
        json={"ServerCustomId": CustomId, "CreateAccount": False},
        headers=settings.get_auth_headers()
    )
    if login_response.status_code != 200:
        login_json = login_response.json()
        if login_json.get('errorCode') == 1002:
            ban_details = login_json.get('errorDetails', {})
            ban_expiration_key = next(iter(ban_details.keys()), "BanReason")
            ban_expiration_list = ban_details.get(ban_expiration_key, [])
            ban_expiration = ban_expiration_list[0] if ban_expiration_list else "No expiration date provided."
            return jsonify({
                'BanReason': f"{ban_expiration_key}: {login_json.get('errorMessage', 'Banned.')}",
                'BanExpiration': ban_expiration,
                'Region': Region,
                'GameMode': GameMode
            }), 403
        return jsonify({'Error': 'PlayFab Login Error', 'Message': login_json.get('errorMessage', 'Unknown error')}), login_response.status_code
    link_response = requests.post(
        url=f"https://{settings.TitleId}.playfabapi.com/Server/LinkServerCustomId",
        json={"PlayFabId": PlayFabId_req, "ServerCustomId": CustomId, "ForceLink": True},
        headers=settings.get_auth_headers()
    )
    if link_response.status_code != 200:
        return jsonify({"status": "error", "step": "LinkServerCustomId", "code": link_response.status_code, "error": link_response.text}), link_response.status_code
    services = {"CosmeticsSync": True, "FriendsInit": True, "GuildSync": False, "SeasonalEvents": True}
    return jsonify({
        "status": "success",
        "GameMode": GameMode,
        "Region": Region,
        "Device": DeviceType,
        "loginData": login_response.json().get("data"),
        "linkData": link_response.json().get("data"),
        "servicesInitialized": services
    })

@app.route("/api/ReturnMyOculusHash")
def return_my_oculus_hash():
    return ReturnFunctionJson(request.get_json(), "ReturnMyOculusHash")

@app.route("/api/ReturnCurrentVersion", methods=["POST", "GET"])
def return_current_version():
    return ReturnFunctionJson(request.get_json(), "ReturnCurrentVersion")

@app.route("/api/TryDistributeCurrency", methods=["POST", "GET"])
def try_distribute_currency():
    return ReturnFunctionJson(request.get_json(), "TryDistributeCurrency")

@app.route("/api/BroadCastMyRoom", methods=["POST", "GET"])
def broadcast_my_room():
    return ReturnFunctionJson(request.get_json(), "BroadCastMyRoom", request.get_json()["FunctionParameter"])

@app.route("/api/ShouldUserAutomutePlayer", methods=["POST", "GET"])
def should_user_automute_player():
    return jsonify(mute_cache)

# Photon Webhook Things
@app.route("/PathCreate", methods=["POST"])
def path_create():
    rjson = request.get_json()
    user_id = rjson.get("UserId")
    return return_function_json("RoomCreated", rjson, user_id)

@app.route("/PathJoin", methods=["POST"])
def path_join():
    rjson = request.get_json()
    user_id = rjson.get("UserId")
    return return_function_json("RoomJoined", rjson, user_id)

@app.route("/PathLeave", methods=["POST"])
def path_leave():
    rjson = request.get_json()
    user_id = rjson.get("UserId")
    rjson["Type"] = "ClientDisconnect"
    return return_function_json("RoomLeft", rjson, user_id)

@app.route("/PathClose", methods=["POST"])
def path_close():
    rjson = request.get_json()
    user_id = rjson.get("UserId")
    rjson["Type"] = "Close"
    return return_function_json("RoomClosed", rjson, user_id)

@app.route("/PathRaiseEvent", methods=["POST"])
def path_raise_event():
    rjson = request.get_json()
    user_id = rjson.get("UserId")
    return return_function_json("RoomEventRaised", rjson, user_id)

@app.route("/PathSetProperties", methods=["POST"])
def path_set_properties():
    rjson = request.get_json()
    user_id = rjson.get("UserId")
    return return_function_json("RoomPropertyUpdated", rjson, user_id)

# New Endpoints (Total >50 with TitleData keys and routes)
@app.route("/api/GetLeaderboard", methods=["POST"])
def get_leaderboard():
    rjson = request.get_json()
    statistic_name = rjson.get("StatisticName", "GlobalScore")
    return return_function_json("GetLeaderboard", {"StatisticName": statistic_name}, rjson.get("PlayFabId"))

@app.route("/api/UpdateStats", methods=["POST"])
def update_stats():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "Statistics"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    return return_function_json("UpdatePlayerStatistics", rjson.get("Statistics"), rjson.get("PlayFabId"))

@app.route("/api/GetInventory", methods=["POST"])
def get_inventory():
    rjson = request.get_json()
    playfab_id = rjson.get("PlayFabId")
    if not playfab_id:
        return jsonify({"error": "Missing PlayFabId"}), 400
    return return_function_json("GetUserInventory", {}, playfab_id)

@app.route("/api/GrantCurrency", methods=["POST"])
def grant_currency():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "Currency", "Amount"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    response = requests.post(
        f"https://{settings.TitleId}.playfabapi.com/Admin/AddUserVirtualCurrency",
        json={
            "PlayFabId": rjson.get("PlayFabId"),
            "VirtualCurrency": rjson.get("Currency"),
            "Amount": rjson.get("Amount")
        },
        headers=settings.get_auth_headers()
    )
    return jsonify(response.json().get("data", {})), response.status_code

@app.route("/api/ReportPlayer", methods=["POST"])
def report_player():
    rjson = request.get_json()
    required_fields = ["ReporterId", "ReportedId", "Reason"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400

    reporter_id = rjson.get("ReporterId")
    reported_id = rjson.get("ReportedId")
    reason_index = rjson.get("Reason")   # this should be the index (int) that maps to a reason via ReportButtonNames

    # Prepare the Data array expected by the CloudScript:
    # args.Data[0] = reported player ID
    # args.Data[1] = reason index
    # args.Data[2] = reported player name (optional, we leave empty – the script will fetch it via GetDisplayNameOfUserId)
    # args.Data[5] = room details (optional, leave empty)
    funcparam = {
        "Data": [reported_id, reason_index, reporter_id, "", "", ""]
    }

    # Execute the CloudScript "ReportedGuy" as the reporter
    result, status = return_function_json("ReportedGuy", funcparam, reporter_id)

    # You can check status if needed, but we'll always return a generic success
    logger.info(f"Player {reporter_id} reported {reported_id} for reason {reason_index}")

    return jsonify({"success": True, "message": "Report submitted"}), 200
@app.route("/api/AddFriend", methods=["POST"])
def add_friend():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "FriendId"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    return return_function_json("AddFriend", {"FriendPlayFabId": rjson.get("FriendId")}, rjson.get("PlayFabId"))

@app.route("/api/RemoveFriend", methods=["POST"])
def remove_friend():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "FriendId"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    return return_function_json("RemoveFriend", {"FriendPlayFabId": rjson.get("FriendId")}, rjson.get("PlayFabId"))

@app.route("/api/GetFriendsList", methods=["POST"])
def get_friends_list():
    rjson = request.get_json()
    playfab_id = rjson.get("PlayFabId")
    if not playfab_id:
        return jsonify({"error": "Missing PlayFabId"}), 400
    return return_function_json("GetFriendsList", {}, playfab_id)

@app.route("/api/CreateParty", methods=["POST"])
def create_party():
    rjson = request.get_json()
    playfab_id = rjson.get("PlayFabId")
    if not playfab_id:
        return jsonify({"error": "Missing PlayFabId"}), 400
    party_id = generate_session_id()
    logger.info(f"Created party {party_id} for {playfab_id}")
    return jsonify({"success": True, "PartyId": party_id}), 200

@app.route("/api/JoinParty", methods=["POST"])
def join_party():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "PartyId"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    logger.info(f"Player {rjson.get('PlayFabId')} joined party {rjson.get('PartyId')}")
    return jsonify({"success": True}), 200

@app.route("/api/LeaveParty", methods=["POST"])
def leave_party():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "PartyId"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    logger.info(f"Player {rjson.get('PlayFabId')} left party {rjson.get('PartyId')}")
    return jsonify({"success": True}), 200

@app.route("/api/InviteToParty", methods=["POST"])
def invite_to_party():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "FriendId", "PartyId"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    logger.info(f"Player {rjson.get('PlayFabId')} invited {rjson.get('FriendId')} to party {rjson.get('PartyId')}")
    return jsonify({"success": True}), 200

@app.route("/api/GetDailyQuests", methods=["POST"])
def get_daily_quests():
    rjson = request.get_json()
    playfab_id = rjson.get("PlayFabId")
    if not playfab_id:
        return jsonify({"error": "Missing PlayFabId"}), 400
    return jsonify({"quests": [{"id": "quest1", "name": "Tag 5 Players", "reward": 100}]}), 200

@app.route("/api/CompleteQuest", methods=["POST"])
def complete_quest():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "QuestId"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    return return_function_json("CompleteQuest", {"QuestId": rjson.get("QuestId")}, rjson.get("PlayFabId"))

@app.route("/api/GetAchievements", methods=["POST"])
def get_achievements():
    rjson = request.get_json()
    playfab_id = rjson.get("PlayFabId")
    if not playfab_id:
        return jsonify({"error": "Missing PlayFabId"}), 400
    return return_function_json("GetPlayerAchievements", {}, playfab_id)

@app.route("/api/UnlockAchievement", methods=["POST"])
def unlock_achievement():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "AchievementId"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    return return_function_json("UnlockAchievement", {"AchievementId": rjson.get("AchievementId")}, rjson.get("PlayFabId"))

@app.route("/api/GetSeasonalEvent", methods=["POST"])
def get_seasonal_event():
    return jsonify({
        "EventName": "WinterFest2025",
        "StartDate": "2025-12-01",
        "EndDate": "2026-01-15",
        "Rewards": ["snow_hat", "ice_gloves"]
    }), 200

@app.route("/api/SubmitFeedback", methods=["POST"])
def submit_feedback():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "Feedback"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    logger.info(f"Feedback from {rjson.get('PlayFabId')}: {rjson.get('Feedback')}")
    return jsonify({"success": True}), 200

@app.route("/api/GetServerStatus", methods=["GET"])
def get_server_status():
    return jsonify({
        "status": "online",
        "uptime": str(timedelta(seconds=int(time() - app.start_time))),
        "activePlayers": random.randint(100, 1000)
    }), 200

@app.route("/api/UpdateProfile", methods=["POST"])
def update_profile():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "DisplayName"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    return return_function_json("UpdateUserTitleDisplayName", {"DisplayName": rjson.get("DisplayName")}, rjson.get("PlayFabId"))

@app.route("/api/GetCosmetics", methods=["POST"])
def get_cosmetics():
    rjson = request.get_json()
    playfab_id = rjson.get("PlayFabId")
    if not playfab_id:
        return jsonify({"error": "Missing PlayFabId"}), 400
    return jsonify({"cosmetics": REDEEMABLE_ITEMS}), 200

@app.route("/api/EquipCosmetic", methods=["POST"])
def equip_cosmetic():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "CosmeticId"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    logger.info(f"Player {rjson.get('PlayFabId')} equipped cosmetic {rjson.get('CosmeticId')}")
    return jsonify({"success": True}), 200

@app.route("/api/TradeItems", methods=["POST"])
def trade_items():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "RecipientId", "Items"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    return return_function_json("TradeItems", {"RecipientId": rjson.get("RecipientId"), "Items": rjson.get("Items")}, rjson.get("PlayFabId"))

@app.route("/api/CreateGuild", methods=["POST"])
def create_guild():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "GuildName"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    guild_id = generate_session_id()
    logger.info(f"Guild {guild_id} created by {rjson.get('PlayFabId')}: {rjson.get('GuildName')}")
    return jsonify({"success": True, "GuildId": guild_id}), 200

@app.route("/api/JoinGuild", methods=["POST"])
def join_guild():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "GuildId"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    logger.info(f"Player {rjson.get('PlayFabId')} joined guild {rjson.get('GuildId')}")
    return jsonify({"success": True}), 200

@app.route("/api/GetGuildInfo", methods=["POST"])
def get_guild_info():
    rjson = request.get_json()
    guild_id = rjson.get("GuildId")
    if not guild_id:
        return jsonify({"error": "Missing GuildId"}), 400
    return jsonify({"guild": {"id": guild_id, "name": "SampleGuild", "members": 10}}), 200

@app.route("/api/GetMatchHistory", methods=["POST"])
def get_match_history():
    rjson = request.get_json()
    playfab_id = rjson.get("PlayFabId")
    if not playfab_id:
        return jsonify({"error": "Missing PlayFabId"}), 400
    return jsonify({"matches": [{"id": "match1", "result": "win", "date": "2025-09-11"}]}), 200

@app.route("/api/StartMatchmaking", methods=["POST"])
def start_matchmaking():
    rjson = request.get_json()
    required_fields = ["PlayFabId", "GameMode"]
    missing_fields = validate_input(rjson, required_fields)
    if missing_fields:
        return jsonify({"error": f"Missing fields: {', '.join(missing_fields)}"}), 400
    logger.info(f"Player {rjson.get('PlayFabId')} started matchmaking for {rjson.get('GameMode')}")
    return jsonify({"success": True, "MatchId": generate_session_id()}), 200

@app.route("/api/CancelMatchmaking", methods=["POST"])
def cancel_matchmaking():
    rjson = request.get_json()
    playfab_id = rjson.get("PlayFabId")
    if not playfab_id:
        return jsonify({"error": "Missing PlayFabId"}), 400
    logger.info(f"Player {rjson.get('PlayFabId')} cancelled matchmaking")
    return jsonify({"success": True}), 200

@app.route("/api/GetServerConfig", methods=["GET"])
def get_server_config():
    return jsonify({
        "version": "1.2.3",
        "maintenance": False,
        "regions": ["US", "EU", "AS"],
        "maxPlayers": 1000
    }), 200


# ========================= RUN =========================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9080)
