const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const multer = require("multer");
const QRCode = require("qrcode");
const sqlite3 = require("sqlite3").verbose();
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const MAX_USERS_PER_SERVER = 5;
const MIN_PASSWORD_LENGTH = 4;
const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_LENGTH = 280;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_ROUTE_POINTS_PER_USER = 50;
const MIN_ROUTE_DISTANCE_METERS = 25;
const MIN_ROUTE_INTERVAL_MS = 20000;
const TYPING_TTL_MS = 2500;

const DATA_ROOT = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_ROOT, "app.sqlite");
const UPLOADS_ROOT = path.join(__dirname, "uploads");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
const db = new sqlite3.Database(DB_PATH);

fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_ROOT));

function dbExec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        lastID: this.lastID,
        changes: this.changes
      });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows || []);
    });
  });
}

function normalizeRoomName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function formatRoomName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function formatUserName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function makeUserKey(name) {
  return formatUserName(name).toLowerCase();
}

function cloneLocation(location) {
  if (!location) {
    return null;
  }

  return {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    address: String(location.address || "").trim() || "Address unavailable",
    updatedAt: location.updatedAt || new Date().toISOString()
  };
}

function distanceInMeters(pointA, pointB) {
  if (!pointA || !pointB) {
    return Infinity;
  }

  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const deltaLat = toRadians(pointB.latitude - pointA.latitude);
  const deltaLng = toRadians(pointB.longitude - pointA.longitude);
  const lat1 = toRadians(pointA.latitude);
  const lat2 = toRadians(pointB.latitude);

  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(haversine));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, storedPassword) {
  if (!password || !storedPassword?.salt || !storedPassword?.hash) {
    return false;
  }

  const candidateHash = crypto.scryptSync(password, storedPassword.salt, 64);
  const roomHash = Buffer.from(storedPassword.hash, "hex");

  if (candidateHash.length !== roomHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateHash, roomHash);
}

function generateInviteToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getRoomUploadDirectory(roomKey) {
  const roomHash = crypto.createHash("sha256").update(roomKey).digest("hex");
  return path.join(UPLOADS_ROOT, roomHash);
}

function getRoomUploadDirectoryName(roomKey) {
  return path.basename(getRoomUploadDirectory(roomKey));
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || "file"));
  const cleanedName = baseName.replace(/[^\w.\- ]+/g, "_").trim();
  return cleanedName || "file";
}

function getAbsoluteUploadPath(fileUrl) {
  if (!fileUrl || !String(fileUrl).startsWith("/uploads/")) {
    return null;
  }

  const relativePath = decodeURIComponent(String(fileUrl).replace(/^\/uploads\//, ""));
  const resolvedPath = path.resolve(UPLOADS_ROOT, relativePath);

  if (!resolvedPath.startsWith(path.resolve(UPLOADS_ROOT))) {
    return null;
  }

  return resolvedPath;
}

function removeStoredFile(filePath) {
  if (!filePath) {
    return;
  }

  fs.rm(filePath, { force: true }, () => {});
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, callback) => {
      const roomDirectory = getRoomUploadDirectory(req.uploadRoomKey);
      fs.mkdir(roomDirectory, { recursive: true }, (error) => {
        callback(error, roomDirectory);
      });
    },
    filename: (_req, file, callback) => {
      const safeOriginalName = sanitizeFileName(file.originalname);
      const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeOriginalName}`;
      callback(null, uniqueName);
    }
  }),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES
  }
});

function createRoomState(data) {
  return {
    roomKey: data.roomKey,
    roomName: data.roomName,
    password: {
      salt: data.passwordSalt,
      hash: data.passwordHash
    },
    ownerName: data.ownerName,
    ownerKey: data.ownerKey,
    isLocked: Boolean(data.isLocked),
    inviteToken: data.inviteToken,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    users: new Map(),
    profiles: new Map(),
    routeHistory: new Map(),
    messages: []
  };
}

function ensureProfile(room, name, timestamp) {
  const userKey = makeUserKey(name);
  let profile = room.profiles.get(userKey);

  if (!profile) {
    profile = {
      userKey,
      name,
      firstJoinedAt: timestamp,
      lastSeenAt: timestamp,
      totalJoins: 0,
      lastLocation: null
    };
    room.profiles.set(userKey, profile);
  }

  return profile;
}

function trimRouteHistoryInMemory(room, userKey) {
  const route = room.routeHistory.get(userKey) || [];
  if (route.length > MAX_ROUTE_POINTS_PER_USER) {
    room.routeHistory.set(userKey, route.slice(-MAX_ROUTE_POINTS_PER_USER));
  }
}

function appendRoutePoint(room, userKey, location) {
  const route = room.routeHistory.get(userKey) || [];
  const lastPoint = route[route.length - 1];
  const nextPoint = cloneLocation(location);
  const lastTime = lastPoint ? new Date(lastPoint.updatedAt).getTime() : 0;
  const nextTime = new Date(nextPoint.updatedAt).getTime();
  const movedEnough = distanceInMeters(lastPoint, nextPoint) >= MIN_ROUTE_DISTANCE_METERS;
  const enoughTimePassed = !lastPoint || nextTime - lastTime >= MIN_ROUTE_INTERVAL_MS;

  if (!lastPoint || movedEnough || enoughTimePassed) {
    route.push(nextPoint);
    room.routeHistory.set(userKey, route);
    trimRouteHistoryInMemory(room, userKey);
    return true;
  }

  return false;
}

function cleanupTyping(room) {
  const now = Date.now();
  for (const user of room.users.values()) {
    if (user.typingUntil && user.typingUntil <= now) {
      user.typingUntil = 0;
    }
  }
}

function getActiveSharer(room, excludeSocketId = "") {
  for (const roomUser of room.users.values()) {
    if (!roomUser.sharingActive) {
      continue;
    }

    if (excludeSocketId && roomUser.id === excludeSocketId) {
      continue;
    }

    return roomUser;
  }

  return null;
}

async function persistSharingProfile(room, user) {
  const timestamp = new Date().toISOString();
  const profile = ensureProfile(room, user.name, timestamp);
  profile.lastSeenAt = timestamp;

  if (user.location) {
    profile.lastLocation = cloneLocation(user.location);
  }

  await persistProfileState(room, profile);
}

function notifySharingBlocked(room, requester, activeSharer) {
  if (!activeSharer || activeSharer.id === requester.id) {
    return;
  }

  const activeSocket = io.sockets.sockets.get(activeSharer.id);
  if (!activeSocket) {
    return;
  }

  activeSocket.emit(
    "share-warning",
    `${requester.name} tried to start sharing while you are already using the live map.`
  );
}

async function approveSharingStart(socket) {
  const context = ensureRoomMember(socket, "share-error");
  if (!context) {
    return;
  }

  const activeSharer = getActiveSharer(context.room, socket.id);
  if (activeSharer) {
    notifySharingBlocked(context.room, context.user, activeSharer);
    socket.emit(
      "share-blocked",
      `${activeSharer.name} is already sharing live location. Try again after they stop.`
    );
    return;
  }

  if (!context.user.sharingActive) {
    context.user.sharingActive = true;
    await persistSharingProfile(context.room, context.user);
    broadcastRoom(context.room.roomKey);
  }

  socket.emit("share-start-approved", "Map access granted. You can start sharing now.");
}

function buildUserSnapshot(room, profile, onlineUser) {
  const route = room.routeHistory.get(profile.userKey) || [];
  const displayLocation = cloneLocation(onlineUser?.location || profile.lastLocation);

  return {
    sessionId: onlineUser ? onlineUser.id : null,
    userKey: profile.userKey,
    name: profile.name,
    isOwner: profile.userKey === room.ownerKey,
    online: Boolean(onlineUser),
    isTyping: Boolean(onlineUser?.typingUntil && onlineUser.typingUntil > Date.now()),
    isSharing: Boolean(onlineUser?.sharingActive),
    joinedAt: profile.firstJoinedAt,
    lastSeenAt: onlineUser ? new Date().toISOString() : profile.lastSeenAt,
    location: displayLocation,
    route: route.map((point) => cloneLocation(point))
  };
}

function getRoomSnapshot(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) {
    return null;
  }

  cleanupTyping(room);

  const now = Date.now();
  const users = [];
  const seenKeys = new Set();
  const typingUsers = [];

  for (const onlineUser of room.users.values()) {
    const profile = ensureProfile(room, onlineUser.name, new Date().toISOString());
    const snapshot = buildUserSnapshot(room, profile, onlineUser);
    users.push(snapshot);
    seenKeys.add(profile.userKey);

    if (onlineUser.typingUntil > now) {
      typingUsers.push(profile.name);
    }
  }

  for (const profile of room.profiles.values()) {
    if (seenKeys.has(profile.userKey)) {
      continue;
    }

    users.push(buildUserSnapshot(room, profile, null));
  }

  users.sort((left, right) => {
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }

    if (left.isOwner !== right.isOwner) {
      return left.isOwner ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  return {
    roomKey: room.roomKey,
    roomName: room.roomName,
    ownerName: room.ownerName,
    ownerKey: room.ownerKey,
    inviteToken: room.inviteToken,
    isLocked: room.isLocked,
    count: room.users.size,
    maxUsers: MAX_USERS_PER_SERVER,
    typingUsers,
    users,
    messages: room.messages.slice(-MAX_CHAT_MESSAGES).map((message) => ({
      id: message.id,
      type: message.type,
      name: message.name,
      text: message.text,
      file: message.file
        ? {
            name: message.file.name,
            size: message.file.size,
            mimeType: message.file.mimeType,
            url: message.file.url
          }
        : null,
      createdAt: message.createdAt
    }))
  };
}

function broadcastRoom(roomKey) {
  const snapshot = getRoomSnapshot(roomKey);
  if (!snapshot) {
    return;
  }

  io.to(roomKey).emit("room-state", snapshot);
}

function getRoomContext(socket) {
  const roomKey = socket.data.roomKey;
  if (!roomKey) {
    return { room: null, user: null };
  }

  const room = rooms.get(roomKey) || null;
  const user = room?.users.get(socket.id) || null;
  return { room, user };
}

function findRoomByInviteToken(inviteToken) {
  if (!inviteToken) {
    return null;
  }

  for (const room of rooms.values()) {
    if (room.inviteToken === inviteToken) {
      return room;
    }
  }

  return null;
}

async function initializeDatabase() {
  await dbExec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS rooms (
      room_key TEXT PRIMARY KEY,
      room_name TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      is_locked INTEGER NOT NULL DEFAULT 0,
      invite_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_profiles (
      room_key TEXT NOT NULL,
      user_key TEXT NOT NULL,
      user_name TEXT NOT NULL,
      first_joined_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      total_joins INTEGER NOT NULL DEFAULT 1,
      last_latitude REAL,
      last_longitude REAL,
      last_address TEXT,
      last_location_at TEXT,
      PRIMARY KEY (room_key, user_key),
      FOREIGN KEY (room_key) REFERENCES rooms(room_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS route_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_key TEXT NOT NULL,
      user_key TEXT NOT NULL,
      user_name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_key) REFERENCES rooms(room_key) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_route_points_room_user_id
      ON route_points(room_key, user_key, id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_key TEXT NOT NULL,
      type TEXT NOT NULL,
      user_name TEXT,
      text TEXT NOT NULL DEFAULT '',
      file_name TEXT,
      file_size INTEGER,
      file_mime TEXT,
      file_url TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_key) REFERENCES rooms(room_key) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room_created
      ON messages(room_key, created_at);
  `);
}

async function loadPersistedRooms() {
  const roomRows = await dbAll(`
    SELECT
      room_key,
      room_name,
      password_salt,
      password_hash,
      owner_name,
      owner_key,
      is_locked,
      invite_token,
      created_at,
      updated_at
    FROM rooms
    ORDER BY created_at ASC
  `);

  for (const row of roomRows) {
    rooms.set(
      row.room_key,
      createRoomState({
        roomKey: row.room_key,
        roomName: row.room_name,
        passwordSalt: row.password_salt,
        passwordHash: row.password_hash,
        ownerName: row.owner_name,
        ownerKey: row.owner_key,
        isLocked: row.is_locked,
        inviteToken: row.invite_token,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    );
  }

  const profileRows = await dbAll(`
    SELECT
      room_key,
      user_key,
      user_name,
      first_joined_at,
      last_seen_at,
      total_joins,
      last_latitude,
      last_longitude,
      last_address,
      last_location_at
    FROM room_profiles
    ORDER BY first_joined_at ASC
  `);

  for (const row of profileRows) {
    const room = rooms.get(row.room_key);
    if (!room) {
      continue;
    }

    room.profiles.set(row.user_key, {
      userKey: row.user_key,
      name: row.user_name,
      firstJoinedAt: row.first_joined_at,
      lastSeenAt: row.last_seen_at,
      totalJoins: Number(row.total_joins || 0),
      lastLocation:
        row.last_latitude !== null && row.last_longitude !== null
          ? {
              latitude: Number(row.last_latitude),
              longitude: Number(row.last_longitude),
              address: row.last_address || "Address unavailable",
              updatedAt: row.last_location_at || row.last_seen_at
            }
          : null
    });
  }

  const routeRows = await dbAll(`
    SELECT
      room_key,
      user_key,
      latitude,
      longitude,
      address,
      created_at
    FROM route_points
    ORDER BY id ASC
  `);

  for (const row of routeRows) {
    const room = rooms.get(row.room_key);
    if (!room) {
      continue;
    }

    const route = room.routeHistory.get(row.user_key) || [];
    route.push({
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      address: row.address,
      updatedAt: row.created_at
    });
    room.routeHistory.set(row.user_key, route);
    trimRouteHistoryInMemory(room, row.user_key);
  }

  const messageRows = await dbAll(`
    SELECT
      id,
      room_key,
      type,
      user_name,
      text,
      file_name,
      file_size,
      file_mime,
      file_url,
      created_at
    FROM messages
    ORDER BY created_at ASC
  `);

  for (const row of messageRows) {
    const room = rooms.get(row.room_key);
    if (!room) {
      continue;
    }

    room.messages.push({
      id: row.id,
      type: row.type,
      name: row.user_name || "",
      text: row.text || "",
      file: row.file_url
        ? {
            name: row.file_name,
            size: Number(row.file_size || 0),
            mimeType: row.file_mime || "application/octet-stream",
            url: row.file_url
          }
        : null,
      createdAt: row.created_at
    });
  }

  for (const room of rooms.values()) {
    ensureProfile(room, room.ownerName, room.createdAt);
  }
}

async function persistRoom(room) {
  room.updatedAt = new Date().toISOString();

  await dbRun(
    `
      INSERT INTO rooms (
        room_key,
        room_name,
        password_salt,
        password_hash,
        owner_name,
        owner_key,
        is_locked,
        invite_token,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_key) DO UPDATE SET
        room_name = excluded.room_name,
        password_salt = excluded.password_salt,
        password_hash = excluded.password_hash,
        owner_name = excluded.owner_name,
        owner_key = excluded.owner_key,
        is_locked = excluded.is_locked,
        invite_token = excluded.invite_token,
        updated_at = excluded.updated_at
    `,
    [
      room.roomKey,
      room.roomName,
      room.password.salt,
      room.password.hash,
      room.ownerName,
      room.ownerKey,
      room.isLocked ? 1 : 0,
      room.inviteToken,
      room.createdAt,
      room.updatedAt
    ]
  );
}

async function recordProfileJoin(room, profile, timestamp) {
  profile.name = formatUserName(profile.name);
  profile.lastSeenAt = timestamp;
  profile.totalJoins += 1;

  await dbRun(
    `
      INSERT INTO room_profiles (
        room_key,
        user_key,
        user_name,
        first_joined_at,
        last_seen_at,
        total_joins,
        last_latitude,
        last_longitude,
        last_address,
        last_location_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_key, user_key) DO UPDATE SET
        user_name = excluded.user_name,
        last_seen_at = excluded.last_seen_at,
        total_joins = room_profiles.total_joins + 1
    `,
    [
      room.roomKey,
      profile.userKey,
      profile.name,
      profile.firstJoinedAt,
      timestamp,
      profile.totalJoins,
      profile.lastLocation ? profile.lastLocation.latitude : null,
      profile.lastLocation ? profile.lastLocation.longitude : null,
      profile.lastLocation ? profile.lastLocation.address : null,
      profile.lastLocation ? profile.lastLocation.updatedAt : null
    ]
  );
}

async function persistProfileState(room, profile) {
  await dbRun(
    `
      INSERT INTO room_profiles (
        room_key,
        user_key,
        user_name,
        first_joined_at,
        last_seen_at,
        total_joins,
        last_latitude,
        last_longitude,
        last_address,
        last_location_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_key, user_key) DO UPDATE SET
        user_name = excluded.user_name,
        last_seen_at = excluded.last_seen_at,
        last_latitude = excluded.last_latitude,
        last_longitude = excluded.last_longitude,
        last_address = excluded.last_address,
        last_location_at = excluded.last_location_at
    `,
    [
      room.roomKey,
      profile.userKey,
      profile.name,
      profile.firstJoinedAt,
      profile.lastSeenAt,
      profile.totalJoins || 1,
      profile.lastLocation ? profile.lastLocation.latitude : null,
      profile.lastLocation ? profile.lastLocation.longitude : null,
      profile.lastLocation ? profile.lastLocation.address : null,
      profile.lastLocation ? profile.lastLocation.updatedAt : null
    ]
  );
}

async function persistRoutePoint(room, profile, location) {
  await dbRun(
    `
      INSERT INTO route_points (
        room_key,
        user_key,
        user_name,
        latitude,
        longitude,
        address,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      room.roomKey,
      profile.userKey,
      profile.name,
      location.latitude,
      location.longitude,
      location.address,
      location.updatedAt
    ]
  );

  await dbRun(
    `
      DELETE FROM route_points
      WHERE room_key = ?
        AND user_key = ?
        AND id NOT IN (
          SELECT id
          FROM route_points
          WHERE room_key = ?
            AND user_key = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `,
    [room.roomKey, profile.userKey, room.roomKey, profile.userKey, MAX_ROUTE_POINTS_PER_USER]
  );
}

async function addRoomMessage(roomKey, message) {
  const room = rooms.get(roomKey);
  if (!room) {
    return null;
  }

  const roomMessage = {
    id: message.id || crypto.randomUUID(),
    type: message.type || "user",
    name: message.name || "",
    text: message.text || "",
    file: message.file
      ? {
          name: message.file.name,
          size: Number(message.file.size || 0),
          mimeType: message.file.mimeType || "application/octet-stream",
          url: message.file.url
        }
      : null,
    createdAt: message.createdAt || new Date().toISOString()
  };

  room.messages.push(roomMessage);

  await dbRun(
    `
      INSERT INTO messages (
        id,
        room_key,
        type,
        user_name,
        text,
        file_name,
        file_size,
        file_mime,
        file_url,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      roomMessage.id,
      roomKey,
      roomMessage.type,
      roomMessage.name || null,
      roomMessage.text,
      roomMessage.file ? roomMessage.file.name : null,
      roomMessage.file ? roomMessage.file.size : null,
      roomMessage.file ? roomMessage.file.mimeType : null,
      roomMessage.file ? roomMessage.file.url : null,
      roomMessage.createdAt
    ]
  );

  return roomMessage;
}

async function deleteRoomMessage(room, messageId) {
  const messageIndex = room.messages.findIndex((message) => message.id === messageId);
  if (messageIndex === -1) {
    return null;
  }

  const [message] = room.messages.splice(messageIndex, 1);
  await dbRun(`DELETE FROM messages WHERE id = ?`, [message.id]);

  if (message.file?.url) {
    removeStoredFile(getAbsoluteUploadPath(message.file.url));
  }

  return message;
}

async function leaveCurrentRoom(socket, options = {}) {
  const roomKey = socket.data.roomKey;
  if (!roomKey) {
    return;
  }

  const room = rooms.get(roomKey);
  if (!room) {
    socket.data.roomKey = null;
    socket.data.userId = null;
    socket.data.userKey = null;
    socket.data.userName = null;
    socket.data.uploadToken = null;
    return;
  }

  const user = room.users.get(socket.id);
  room.users.delete(socket.id);
  socket.leave(roomKey);

  socket.data.roomKey = null;
  socket.data.userId = null;
  socket.data.userKey = null;
  socket.data.userName = null;
  socket.data.uploadToken = null;

  if (user) {
    const timestamp = new Date().toISOString();
    const profile = ensureProfile(room, user.name, timestamp);
    profile.lastSeenAt = timestamp;

    if (user.location) {
      profile.lastLocation = cloneLocation(user.location);
    }

    await persistProfileState(room, profile);

    if (options.systemMessage) {
      await addRoomMessage(roomKey, {
        type: "system",
        text: options.systemMessage
      });
    }
  }

  if (options.broadcast !== false) {
    broadcastRoom(roomKey);
  }
}

function resolveUploadUser(roomKey, uploadToken) {
  const room = rooms.get(roomKey);
  if (!room || !uploadToken) {
    return null;
  }

  const user = Array.from(room.users.values()).find((candidate) => candidate.uploadToken === uploadToken);
  if (!user) {
    return null;
  }

  return { room, user };
}

function validateUploadRequest(req, res, next) {
  const roomKey = normalizeRoomName(req.query.roomKey);
  const uploadToken = String(req.headers["x-upload-token"] || "").trim();

  if (!roomKey || !uploadToken) {
    res.status(400).json({ error: "Missing room upload credentials." });
    return;
  }

  const uploadContext = resolveUploadUser(roomKey, uploadToken);
  if (!uploadContext) {
    res.status(403).json({ error: "Upload access denied for this server." });
    return;
  }

  req.uploadRoomKey = roomKey;
  req.uploadUser = uploadContext.user;
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get("/api/invite/:token", (req, res) => {
  const inviteToken = String(req.params.token || "").trim();
  const room = findRoomByInviteToken(inviteToken);

  if (!room) {
    res.status(404).json({ error: "Invite not found." });
    return;
  }

  res.json({
    roomName: room.roomName,
    roomKey: room.roomKey,
    ownerName: room.ownerName,
    isLocked: room.isLocked
  });
});

app.get("/api/invite/:token/qr", async (req, res) => {
  const inviteToken = String(req.params.token || "").trim();
  const room = findRoomByInviteToken(inviteToken);

  if (!room) {
    res.status(404).type("text/plain").send("Invite not found.");
    return;
  }

  const inviteUrl = `${req.protocol}://${req.get("host")}/?invite=${encodeURIComponent(inviteToken)}`;
  const qrSvg = await QRCode.toString(inviteUrl, {
    type: "svg",
    margin: 1,
    width: 220,
    color: {
      dark: "#1f2937",
      light: "#0000"
    }
  });

  res.type("image/svg+xml").send(qrSvg);
});

app.post("/api/upload", validateUploadRequest, (req, res) => {
  upload.single("file")(req, res, async (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Files can be up to 100 GB." });
        return;
      }

      res.status(400).json({ error: "Unable to upload this file." });
      return;
    }

    try {
      const roomKey = req.uploadRoomKey;
      const room = rooms.get(roomKey);
      const user = room?.users.get(req.uploadUser.id);

      if (!room || !user || user.uploadToken !== req.uploadUser.uploadToken) {
        removeStoredFile(req.file?.path);
        res.status(403).json({ error: "You are no longer connected to this server." });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: "Choose a file before uploading." });
        return;
      }

      const caption = String(req.body?.text || "").trim();
      if (caption.length > MAX_CHAT_LENGTH) {
        removeStoredFile(req.file.path);
        res.status(400).json({ error: `Captions can be up to ${MAX_CHAT_LENGTH} characters.` });
        return;
      }

      const originalName = path.basename(req.file.originalname || req.file.filename);
      const roomDirectoryName = getRoomUploadDirectoryName(roomKey);
      const encodedFileName = encodeURIComponent(req.file.filename);

      user.typingUntil = 0;

      await addRoomMessage(roomKey, {
        type: "file",
        name: user.name,
        text: caption,
        file: {
          name: originalName,
          size: req.file.size,
          mimeType: req.file.mimetype || "application/octet-stream",
          url: `/uploads/${roomDirectoryName}/${encodedFileName}`
        }
      });

      broadcastRoom(roomKey);
      res.status(201).json({ ok: true });
    } catch (uploadError) {
      console.error(uploadError);
      removeStoredFile(req.file?.path);
      res.status(500).json({ error: "Unable to upload this file." });
    }
  });
});

function emitSocketError(socket, channel, message) {
  socket.emit(channel, message);
}

function wrapSocketHandler(socket, handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      console.error(error);
      socket.emit("server-error", "Something went wrong.");
    }
  };
}

function ensureRoomMember(socket, errorChannel = "join-error") {
  const { room, user } = getRoomContext(socket);
  if (!room || !user) {
    emitSocketError(socket, errorChannel, "Join a server first.");
    return null;
  }

  return { room, user };
}

function ensureOwner(socket) {
  const context = ensureRoomMember(socket, "admin-error");
  if (!context) {
    return null;
  }

  if (context.user.userKey !== context.room.ownerKey) {
    emitSocketError(socket, "admin-error", "Only the server owner can do that.");
    return null;
  }

  return context;
}

async function joinRoom(socket, payload, mode) {
  const requestedUserName = formatUserName(payload?.userName);
  const requestedPassword = String(payload?.password || "").trim();
  const inviteToken = String(payload?.inviteToken || "").trim();
  let rawRoomName = formatRoomName(payload?.roomName);
  let roomKey = normalizeRoomName(rawRoomName);
  let room = roomKey ? rooms.get(roomKey) || null : null;

  if (!requestedUserName || requestedUserName.length < 2) {
    emitSocketError(socket, "join-error", "Enter a name with at least 2 characters.");
    return;
  }

  if (mode === "join" && inviteToken) {
    const inviteRoom = findRoomByInviteToken(inviteToken);
    if (inviteRoom) {
      room = inviteRoom;
      roomKey = inviteRoom.roomKey;
      rawRoomName = inviteRoom.roomName;
    }
  }

  if (mode === "create") {
    if (!rawRoomName || rawRoomName.length < 2) {
      emitSocketError(socket, "join-error", "Enter a server name with at least 2 characters.");
      return;
    }

    if (requestedPassword.length < MIN_PASSWORD_LENGTH) {
      emitSocketError(socket, "join-error", `Enter a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    if (room) {
      emitSocketError(socket, "join-error", "That server already exists. Join it instead.");
      return;
    }

    const password = hashPassword(requestedPassword);
    const now = new Date().toISOString();
    room = createRoomState({
      roomKey,
      roomName: rawRoomName,
      passwordSalt: password.salt,
      passwordHash: password.hash,
      ownerName: requestedUserName,
      ownerKey: makeUserKey(requestedUserName),
      isLocked: false,
      inviteToken: generateInviteToken(),
      createdAt: now,
      updatedAt: now
    });
    rooms.set(roomKey, room);
    await persistRoom(room);
  }

  if (mode === "join") {
    if (!room) {
      emitSocketError(socket, "join-error", "That server does not exist yet. Create it first.");
      return;
    }

    const isOwner = makeUserKey(requestedUserName) === room.ownerKey;
    if (room.isLocked && !isOwner) {
      emitSocketError(socket, "join-error", "This server is locked by the owner.");
      return;
    }

    const hasInviteAccess = Boolean(inviteToken) && room.inviteToken === inviteToken;
    const hasPasswordAccess = requestedPassword.length >= MIN_PASSWORD_LENGTH && verifyPassword(requestedPassword, room.password);

    if (!hasInviteAccess && !hasPasswordAccess) {
      emitSocketError(socket, "join-error", "Enter the correct password or use a valid invite link.");
      return;
    }
  }

  const duplicateName = Array.from(room.users.values()).find(
    (user) => user.userKey === makeUserKey(requestedUserName) && user.id !== socket.id
  );

  if (duplicateName) {
    emitSocketError(socket, "join-error", "That name is already being used in this server.");
    return;
  }

  if (room.users.size >= MAX_USERS_PER_SERVER && !room.users.has(socket.id)) {
    emitSocketError(socket, "join-error", "This server is full. Each server can hold up to 5 users.");
    return;
  }

  await leaveCurrentRoom(socket, { broadcast: true });

  const timestamp = new Date().toISOString();
  const profile = ensureProfile(room, requestedUserName, timestamp);
  profile.name = requestedUserName;
  profile.lastSeenAt = timestamp;
  await recordProfileJoin(room, profile, timestamp);

  const user = {
    id: socket.id,
    name: requestedUserName,
    userKey: profile.userKey,
    joinedAt: Date.now(),
    location: cloneLocation(profile.lastLocation),
    sharingActive: false,
    uploadToken: crypto.randomBytes(24).toString("hex"),
    typingUntil: 0
  };

  room.users.set(socket.id, user);
  socket.join(room.roomKey);
  socket.data.roomKey = room.roomKey;
  socket.data.userId = socket.id;
  socket.data.userKey = user.userKey;
  socket.data.userName = user.name;
  socket.data.uploadToken = user.uploadToken;

  await addRoomMessage(room.roomKey, {
    type: "system",
    text: `${requestedUserName} joined the server.`
  });

  socket.emit("joined-room", {
    roomName: room.roomName,
    roomKey: room.roomKey,
    userName: requestedUserName,
    maxUsers: MAX_USERS_PER_SERVER,
    uploadToken: user.uploadToken
  });

  broadcastRoom(room.roomKey);
}

io.on(
  "connection",
  (socket) => {
    socket.data.roomKey = null;
    socket.data.userId = null;
    socket.data.userKey = null;
    socket.data.userName = null;
    socket.data.uploadToken = null;

    socket.on(
      "create-server",
      wrapSocketHandler(socket, async (payload) => {
        await joinRoom(socket, payload, "create");
      })
    );

    socket.on(
      "join-server",
      wrapSocketHandler(socket, async (payload) => {
        await joinRoom(socket, payload, "join");
      })
    );

    socket.on(
      "request-share-start",
      wrapSocketHandler(socket, async () => {
        await approveSharingStart(socket);
      })
    );

    socket.on(
      "location-update",
      wrapSocketHandler(socket, async (payload) => {
        const context = ensureRoomMember(socket, "share-error");
        if (!context) {
          return;
        }

        const activeSharer = getActiveSharer(context.room, socket.id);
        if (!context.user.sharingActive || activeSharer) {
          if (activeSharer) {
            notifySharingBlocked(context.room, context.user, activeSharer);
            socket.emit(
              "share-blocked",
              `${activeSharer.name} is already sharing live location. Wait until they stop.`
            );
          } else {
            emitSocketError(socket, "share-error", "Tap Start live sharing before sending your location.");
          }
          return;
        }

        const latitude = Number(payload?.latitude);
        const longitude = Number(payload?.longitude);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return;
        }

        const location = {
          latitude,
          longitude,
          address: String(payload?.address || "").trim() || "Address unavailable",
          updatedAt: payload?.updatedAt || new Date().toISOString()
        };

        context.user.location = cloneLocation(location);
        context.user.sharingActive = true;

        const profile = ensureProfile(context.room, context.user.name, location.updatedAt);
        profile.lastSeenAt = location.updatedAt;
        profile.lastLocation = cloneLocation(location);
        await persistProfileState(context.room, profile);

        if (appendRoutePoint(context.room, profile.userKey, location)) {
          await persistRoutePoint(context.room, profile, location);
        }

        broadcastRoom(context.room.roomKey);
      })
    );

    socket.on(
      "sharing-state",
      wrapSocketHandler(socket, async (payload) => {
        const context = ensureRoomMember(socket, "share-error");
        if (!context) {
          return;
        }

        if (Boolean(payload?.isSharing)) {
          await approveSharingStart(socket);
          return;
        }

        if (!context.user.sharingActive) {
          return;
        }

        context.user.sharingActive = false;
        await persistSharingProfile(context.room, context.user);
        broadcastRoom(context.room.roomKey);
      })
    );

    socket.on(
      "typing-state",
      wrapSocketHandler(socket, async (payload) => {
        const context = ensureRoomMember(socket, "chat-error");
        if (!context) {
          return;
        }

        context.user.typingUntil = Boolean(payload?.isTyping) ? Date.now() + TYPING_TTL_MS : 0;
        broadcastRoom(context.room.roomKey);
      })
    );

    socket.on(
      "send-message",
      wrapSocketHandler(socket, async (payload) => {
        const context = ensureRoomMember(socket, "chat-error");
        if (!context) {
          return;
        }

        const text = String(payload?.text || "").trim();
        if (!text) {
          emitSocketError(socket, "chat-error", "Type a message before sending.");
          return;
        }

        if (text.length > MAX_CHAT_LENGTH) {
          emitSocketError(socket, "chat-error", `Messages can be up to ${MAX_CHAT_LENGTH} characters.`);
          return;
        }

        context.user.typingUntil = 0;
        await addRoomMessage(context.room.roomKey, {
          type: "user",
          name: context.user.name,
          text
        });

        broadcastRoom(context.room.roomKey);
      })
    );

    socket.on(
      "delete-message",
      wrapSocketHandler(socket, async (payload) => {
        const context = ensureOwner(socket);
        if (!context) {
          return;
        }

        const messageId = String(payload?.messageId || "").trim();
        if (!messageId) {
          emitSocketError(socket, "admin-error", "Choose a message to delete.");
          return;
        }

        const removedMessage = await deleteRoomMessage(context.room, messageId);
        if (!removedMessage) {
          emitSocketError(socket, "admin-error", "That message could not be found.");
          return;
        }

        socket.emit("admin-feedback", "Message deleted.");
        broadcastRoom(context.room.roomKey);
      })
    );

    socket.on(
      "kick-user",
      wrapSocketHandler(socket, async (payload) => {
        const context = ensureOwner(socket);
        if (!context) {
          return;
        }

        const targetSessionId = String(payload?.sessionId || "").trim();
        if (!targetSessionId) {
          emitSocketError(socket, "admin-error", "Choose a member to remove.");
          return;
        }

        if (targetSessionId === socket.id) {
          emitSocketError(socket, "admin-error", "You cannot remove yourself.");
          return;
        }

        const targetSocket = io.sockets.sockets.get(targetSessionId);
        const targetUser = context.room.users.get(targetSessionId);

        if (!targetSocket || !targetUser) {
          emitSocketError(socket, "admin-error", "That member is no longer online.");
          return;
        }

        if (targetUser.userKey === context.room.ownerKey) {
          emitSocketError(socket, "admin-error", "The owner cannot be removed.");
          return;
        }

        await leaveCurrentRoom(targetSocket, {
          systemMessage: `${targetUser.name} was removed by the owner.`
        });

        targetSocket.emit("forced-leave", "You were removed by the server owner.");
        socket.emit("admin-feedback", `${targetUser.name} was removed.`);
      })
    );

    socket.on(
      "toggle-lock",
      wrapSocketHandler(socket, async () => {
        const context = ensureOwner(socket);
        if (!context) {
          return;
        }

        context.room.isLocked = !context.room.isLocked;
        await persistRoom(context.room);
        await addRoomMessage(context.room.roomKey, {
          type: "system",
          text: context.room.isLocked
            ? `${context.user.name} locked the server.`
            : `${context.user.name} unlocked the server.`
        });

        socket.emit("admin-feedback", context.room.isLocked ? "Server locked." : "Server unlocked.");
        broadcastRoom(context.room.roomKey);
      })
    );

    socket.on(
      "change-password",
      wrapSocketHandler(socket, async (payload) => {
        const context = ensureOwner(socket);
        if (!context) {
          return;
        }

        const nextPassword = String(payload?.password || "").trim();
        if (nextPassword.length < MIN_PASSWORD_LENGTH) {
          emitSocketError(socket, "admin-error", `Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
          return;
        }

        context.room.password = hashPassword(nextPassword);
        await persistRoom(context.room);
        await addRoomMessage(context.room.roomKey, {
          type: "system",
          text: `${context.user.name} changed the server password.`
        });

        socket.emit("admin-feedback", "Password updated.");
        broadcastRoom(context.room.roomKey);
      })
    );

    socket.on(
      "leave-server",
      wrapSocketHandler(socket, async () => {
        const { room, user } = getRoomContext(socket);
        const message = room && user ? `${user.name} left the server.` : null;
        await leaveCurrentRoom(socket, { systemMessage: message });
        socket.emit("left-room");
      })
    );

    socket.on("disconnect", () => {
      leaveCurrentRoom(socket, {
        systemMessage: socket.data.userName ? `${socket.data.userName} disconnected.` : null
      }).catch((error) => {
        console.error(error);
      });
    });
  }
);

async function start() {
  await initializeDatabase();
  await loadPersistedRooms();

  server.listen(PORT, () => {
    console.log(`Live location server running on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
