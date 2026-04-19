const socket = io();

const DEFAULT_TITLE = "Live Location Servers";
const MAX_USERS_PER_SERVER = 5;
const MAX_CHAT_LENGTH = 280;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024 * 1024;

const entryForm = document.getElementById("entry-form");
const userNameInput = document.getElementById("user-name");
const roomNameInput = document.getElementById("room-name");
const passwordInput = document.getElementById("room-password");
const createButton = document.getElementById("create-btn");
const joinButton = document.getElementById("join-btn");
const entryMessage = document.getElementById("entry-message");
const inviteBanner = document.getElementById("invite-banner");
const inviteBannerTitle = document.getElementById("invite-banner-title");
const inviteBannerCopy = document.getElementById("invite-banner-copy");

const roomPanel = document.getElementById("room-panel");
const roomTitle = document.getElementById("room-title");
const roomSubtitle = document.getElementById("room-subtitle");
const ownerBadge = document.getElementById("owner-badge");
const lockBadge = document.getElementById("lock-badge");
const capacityBadge = document.getElementById("capacity-badge");
const leaveButton = document.getElementById("leave-btn");

const shareButton = document.getElementById("share-btn");
const stopButton = document.getElementById("stop-btn");
const shareStatus = document.getElementById("share-status");

const mapTitle = document.getElementById("map-title");
const mapCanvas = document.getElementById("map-canvas");
const mapEmpty = document.getElementById("map-empty");
const mapsLink = document.getElementById("maps-link");
const directionsLink = document.getElementById("directions-link");
const routeSummary = document.getElementById("route-summary");
const routeList = document.getElementById("route-list");

const inviteLinkInput = document.getElementById("invite-link");
const copyInviteButton = document.getElementById("copy-invite-btn");
const openInviteButton = document.getElementById("open-invite-btn");
const inviteQrImage = document.getElementById("invite-qr");
const inviteNote = document.getElementById("invite-note");
const inviteStatus = document.getElementById("invite-status");

const adminPanel = document.getElementById("admin-panel");
const lockButton = document.getElementById("lock-btn");
const adminPasswordInput = document.getElementById("admin-password-input");
const changePasswordButton = document.getElementById("change-password-btn");
const adminStatus = document.getElementById("admin-status");

const chatUnreadBadge = document.getElementById("chat-unread-badge");
const typingIndicator = document.getElementById("typing-indicator");
const chatMessagesContainer = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatStatus = document.getElementById("chat-status");
const chatFileInput = document.getElementById("chat-file-input");
const chatFileButton = document.getElementById("chat-file-btn");
const chatSendButton = document.getElementById("chat-send-btn");
const chatUploadPanel = document.getElementById("chat-upload-panel");
const chatUploadName = document.getElementById("chat-upload-name");
const chatUploadPercent = document.getElementById("chat-upload-percent");
const chatUploadBar = document.getElementById("chat-upload-bar");
const chatUploadDetail = document.getElementById("chat-upload-detail");

const membersList = document.getElementById("members-list");

const state = {
  currentUserName: "",
  currentUserKey: "",
  currentRoomName: "",
  currentRoomKey: "",
  roomOwnerName: "",
  roomOwnerKey: "",
  roomInviteToken: "",
  roomLocked: false,
  uploadToken: "",
  roomUsers: [],
  chatMessages: [],
  chatSignature: "",
  pendingInviteToken: "",
  pendingInviteRoomName: "",
  unreadCount: 0,
  chatFocused: false,
  typingState: false,
  typingStopTimer: null,
  shareRequestPending: false,
  isUploading: false,
  uploadProgressTimer: null,
  watchId: null,
  selectedUserKey: "",
  lastAddress: "",
  lastGeocodeTime: 0,
  lastGeocodePoint: null,
  geocodeRequestId: 0
};

function setMessage(element, text, type = "") {
  element.textContent = text;
  element.className = "message";
  if (type) {
    element.classList.add(type);
  }
}

function makeUserKey(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeRoomName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function sanitizeForm() {
  return {
    userName: userNameInput.value.trim(),
    roomName: roomNameInput.value.trim(),
    password: passwordInput.value.trim()
  };
}

function currentUser() {
  return state.roomUsers.find((user) => user.userKey === state.currentUserKey) || null;
}

function buildGoogleMapsUrl(latitude, longitude) {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

function buildDirectionsUrl(origin, destination) {
  if (!destination) {
    return "#";
  }

  const directionsUrl = new URL("https://www.google.com/maps/dir/");
  directionsUrl.searchParams.set("api", "1");
  directionsUrl.searchParams.set("destination", `${destination.latitude},${destination.longitude}`);
  directionsUrl.searchParams.set("travelmode", "driving");

  if (origin && Number.isFinite(origin.latitude) && Number.isFinite(origin.longitude)) {
    const samePoint =
      Math.abs(origin.latitude - destination.latitude) < 0.000001 &&
      Math.abs(origin.longitude - destination.longitude) < 0.000001;

    if (!samePoint) {
      directionsUrl.searchParams.set("origin", `${origin.latitude},${origin.longitude}`);
    }
  }

  return directionsUrl.toString();
}

function buildGoogleMapsEmbedUrl(latitude, longitude, label = "") {
  const query = label ? `${latitude},${longitude} (${label})` : `${latitude},${longitude}`;
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&z=15&output=embed`;
}

function formatDate(timestamp) {
  if (!timestamp) {
    return "Just now";
  }

  return new Date(timestamp).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "Now";
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return "just now";
  }

  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size < 0) {
    return "Unknown size";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatDistanceMeters(distance) {
  if (!Number.isFinite(distance) || distance < 0) {
    return "Unknown distance";
  }

  if (distance < 1000) {
    return `${Math.round(distance)} m`;
  }

  const kilometers = distance / 1000;
  return `${kilometers.toFixed(kilometers >= 10 ? 0 : 1)} km`;
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

function clearUploadProgressTimer() {
  if (state.uploadProgressTimer !== null) {
    window.clearTimeout(state.uploadProgressTimer);
    state.uploadProgressTimer = null;
  }
}

function clearTypingStopTimer() {
  if (state.typingStopTimer !== null) {
    window.clearTimeout(state.typingStopTimer);
    state.typingStopTimer = null;
  }
}

function setUploadUiActive(isActive) {
  state.isUploading = isActive;
  chatFileButton.disabled = isActive;
  chatFileInput.disabled = isActive;
  chatSendButton.disabled = isActive;
}

function resetUploadProgress() {
  clearUploadProgressTimer();
  chatUploadPanel.classList.add("hidden");
  chatUploadName.textContent = "Uploading file";
  chatUploadPercent.textContent = "0%";
  chatUploadBar.style.width = "0%";
  chatUploadDetail.textContent = "0 B of 0 B uploaded";
}

function scheduleUploadProgressReset() {
  clearUploadProgressTimer();
  state.uploadProgressTimer = window.setTimeout(() => {
    resetUploadProgress();
  }, 1500);
}

function updateUploadProgress(fileName, loaded, total) {
  clearUploadProgressTimer();
  chatUploadPanel.classList.remove("hidden");
  chatUploadName.textContent = fileName;

  const safeLoaded = Math.max(0, loaded || 0);
  const safeTotal = Math.max(safeLoaded, total || 0);
  const percent = safeTotal > 0 ? Math.min(100, Math.round((safeLoaded / safeTotal) * 100)) : 0;

  chatUploadPercent.textContent = `${percent}%`;
  chatUploadBar.style.width = `${percent}%`;
  chatUploadDetail.textContent =
    safeTotal > 0
      ? `${formatFileSize(safeLoaded)} of ${formatFileSize(safeTotal)} uploaded`
      : `${formatFileSize(safeLoaded)} uploaded`;
}

function uploadFileRequest(file, caption) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);
    if (caption) {
      formData.append("text", caption);
    }

    const request = new XMLHttpRequest();
    request.open("POST", `/api/upload?roomKey=${encodeURIComponent(state.currentRoomKey)}`);
    request.setRequestHeader("x-upload-token", state.uploadToken);

    request.upload.addEventListener("progress", (event) => {
      updateUploadProgress(file.name, event.loaded, event.lengthComputable ? event.total : file.size);
    });

    request.addEventListener("load", () => {
      let payload = {};

      try {
        payload = request.responseText ? JSON.parse(request.responseText) : {};
      } catch (_error) {
        payload = {};
      }

      if (request.status >= 200 && request.status < 300) {
        updateUploadProgress(file.name, file.size, file.size);
        resolve(payload);
        return;
      }

      reject(new Error(payload.error || "Unable to upload this file."));
    });

    request.addEventListener("error", () => {
      reject(new Error("Network error while uploading the file."));
    });

    request.send(formData);
  });
}

function getChatSignature(messages) {
  const lastMessage = messages[messages.length - 1];
  return `${messages.length}:${lastMessage?.id || ""}`;
}

function updateDocumentTitle() {
  document.title = state.unreadCount > 0 ? `(${state.unreadCount}) ${DEFAULT_TITLE}` : DEFAULT_TITLE;
}

function resetUnreadCount() {
  state.unreadCount = 0;
  chatUnreadBadge.classList.add("hidden-badge");
  chatUnreadBadge.textContent = "0 unread";
  updateDocumentTitle();
}

function renderUnreadBadge() {
  if (state.unreadCount <= 0) {
    chatUnreadBadge.classList.add("hidden-badge");
    chatUnreadBadge.textContent = "0 unread";
    updateDocumentTitle();
    return;
  }

  chatUnreadBadge.classList.remove("hidden-badge");
  chatUnreadBadge.textContent = `${state.unreadCount} unread`;
  updateDocumentTitle();
}

function setInviteBannerVisibility(isVisible, roomName = "") {
  inviteBanner.classList.toggle("hidden", !isVisible);
  if (isVisible && roomName) {
    inviteBannerTitle.textContent = `${roomName} invite loaded`;
    inviteBannerCopy.textContent = "Enter your name to join quickly. A valid invite link can replace the password.";
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const temporaryInput = document.createElement("textarea");
  temporaryInput.value = text;
  document.body.appendChild(temporaryInput);
  temporaryInput.select();
  document.execCommand("copy");
  document.body.removeChild(temporaryInput);
}

async function loadInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get("invite");

  if (!inviteToken) {
    state.pendingInviteToken = "";
    state.pendingInviteRoomName = "";
    setInviteBannerVisibility(false);
    return;
  }

  state.pendingInviteToken = inviteToken.trim();

  try {
    const response = await fetch(`/api/invite/${encodeURIComponent(state.pendingInviteToken)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Invite link is not valid anymore.");
    }

    roomNameInput.value = payload.roomName || "";
    state.pendingInviteRoomName = payload.roomName || "";
    setInviteBannerVisibility(true, payload.roomName || "Invited server");
    setMessage(entryMessage, `Invite ready for ${payload.roomName}. Enter your name and click Join server.`, "success");
  } catch (error) {
    state.pendingInviteToken = "";
    state.pendingInviteRoomName = "";
    setInviteBannerVisibility(false);
    setMessage(entryMessage, error.message || "Invite link is not valid anymore.", "error");
  }
}

async function reverseGeocode(latitude, longitude) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", latitude);
  url.searchParams.set("lon", longitude);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("Unable to resolve address.");
  }

  const data = await response.json();
  return data.display_name || "Address unavailable";
}

function initMap() {
  mapCanvas.setAttribute("loading", "lazy");
  mapCanvas.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
}

function getActiveSharingUser() {
  return state.roomUsers.find((user) => user.isSharing && user.location) || null;
}

function ensureSelectedUser() {
  const activeSharer = getActiveSharingUser();
  if (activeSharer) {
    state.selectedUserKey = activeSharer.userKey;
    return activeSharer;
  }

  const selected = state.roomUsers.find((user) => user.userKey === state.selectedUserKey && user.location);
  if (selected) {
    return selected;
  }

  const current = currentUser();
  if (current?.location) {
    state.selectedUserKey = current.userKey;
    return current;
  }

  const firstWithLocation = state.roomUsers.find((user) => user.location);
  state.selectedUserKey = firstWithLocation?.userKey || "";
  return firstWithLocation || null;
}

function setMapLinkState(anchor, href) {
  if (!href || href === "#") {
    anchor.href = "#";
    anchor.classList.add("disabled-link");
    return;
  }

  anchor.href = href;
  anchor.classList.remove("disabled-link");
}

function shouldUsePendingInvite(roomName) {
  if (!state.pendingInviteToken) {
    return false;
  }

  if (!state.pendingInviteRoomName) {
    return true;
  }

  const normalizedRequestedRoom = normalizeRoomName(roomName);
  return !normalizedRequestedRoom || normalizedRequestedRoom === normalizeRoomName(state.pendingInviteRoomName);
}

function renderRouteList(selectedUser) {
  routeList.innerHTML = "";

  if (!selectedUser?.route?.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "member-meta";
    emptyState.textContent = "No route history yet for this member.";
    routeList.appendChild(emptyState);
    return;
  }

  selectedUser.route
    .slice()
    .reverse()
    .slice(0, 8)
    .forEach((point) => {
      const item = document.createElement("article");
      item.className = "route-item";

      const address = document.createElement("p");
      address.textContent = point.address || "Address unavailable";

      const time = document.createElement("p");
      time.className = "route-item-time";
      time.textContent = formatDate(point.updatedAt);

      item.append(address, time);
      routeList.appendChild(item);
    });
}

function renderMap() {
  initMap();

  const activeSharer = getActiveSharingUser();
  const selectedUser = activeSharer ? ensureSelectedUser() : null;

  if (!activeSharer || !selectedUser?.location) {
    mapTitle.textContent = "Waiting for live sharer";
    routeSummary.textContent = "The shared room map stays blank until someone starts live sharing.";
    routeList.innerHTML = "";
    mapEmpty.hidden = false;
    mapCanvas.hidden = true;
    mapCanvas.removeAttribute("src");
    setMapLinkState(mapsLink, "#");
    setMapLinkState(directionsLink, "#");
    return;
  }

  const current = currentUser();
  const routePoints = selectedUser.route || [];
  const isLiveSharedMap = Boolean(activeSharer && activeSharer.userKey === selectedUser.userKey);

  mapTitle.textContent = isLiveSharedMap
    ? `${selectedUser.name} is sharing this map`
    : `${selectedUser.name}'s Google Map`;
  mapEmpty.hidden = true;
  mapCanvas.hidden = false;
  mapCanvas.src = buildGoogleMapsEmbedUrl(
    selectedUser.location.latitude,
    selectedUser.location.longitude,
    selectedUser.name
  );
  setMapLinkState(mapsLink, buildGoogleMapsUrl(selectedUser.location.latitude, selectedUser.location.longitude));
  setMapLinkState(
    directionsLink,
    buildDirectionsUrl(current?.location && current.userKey !== selectedUser.userKey ? current.location : null, selectedUser.location)
  );

  const distance =
    current?.location && current.userKey !== selectedUser.userKey
      ? distanceInMeters(current.location, selectedUser.location)
      : null;

  routeSummary.textContent =
    isLiveSharedMap && distance !== null && Number.isFinite(distance)
      ? `${selectedUser.name} is sharing this live map with everyone in the server. Their latest location is about ${formatDistanceMeters(distance)} away from you.`
      : isLiveSharedMap
        ? `${selectedUser.name} is sharing this live map with everyone in the server. Latest update was ${formatRelativeTime(selectedUser.location.updatedAt)}.`
        : distance !== null && Number.isFinite(distance)
          ? `${selectedUser.name} has ${routePoints.length} saved route points. Their Google Map is centered on the latest shared location and they are about ${formatDistanceMeters(distance)} away from you.`
          : `${selectedUser.name} has ${routePoints.length} saved route points. Their Google Map is centered on the latest shared location from ${formatRelativeTime(selectedUser.location.updatedAt)}.`;

  renderRouteList(selectedUser);
}

function renderInviteCard() {
  if (!state.roomInviteToken) {
    inviteLinkInput.value = "";
    openInviteButton.href = "#";
    inviteQrImage.removeAttribute("src");
    inviteNote.textContent = "Invite details will appear after you join a server.";
    return;
  }

  const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(state.roomInviteToken)}`;
  inviteLinkInput.value = inviteUrl;
  openInviteButton.href = inviteUrl;
  inviteQrImage.src = `/api/invite/${encodeURIComponent(state.roomInviteToken)}/qr`;
  inviteNote.textContent = state.roomLocked
    ? "The owner has locked this room. Unlock it before new people can join."
    : "Share this link or QR code so people can join faster.";
}

function renderAdminPanel() {
  const isOwner = state.currentUserKey && state.currentUserKey === state.roomOwnerKey;
  adminPanel.classList.toggle("hidden", !isOwner);
  ownerBadge.classList.toggle("hidden", !isOwner);

  if (!isOwner) {
    return;
  }

  lockButton.textContent = state.roomLocked ? "Unlock server" : "Lock server";
}

function renderTopBar() {
  roomTitle.textContent = state.currentRoomName;
  roomSubtitle.textContent = `Owner: ${state.roomOwnerName || "Unknown"} - ${state.roomLocked ? "Locked" : "Unlocked"} server`;
  lockBadge.textContent = state.roomLocked ? "Locked" : "Unlocked";
  capacityBadge.textContent = `${state.roomUsers.filter((user) => user.online).length} / ${MAX_USERS_PER_SERVER} users`;
}

function renderTypingIndicator(typingUsers) {
  const visibleTypers = (typingUsers || []).filter((name) => makeUserKey(name) !== state.currentUserKey);

  if (visibleTypers.length === 0) {
    typingIndicator.textContent = "No one is typing right now.";
    return;
  }

  if (visibleTypers.length === 1) {
    typingIndicator.textContent = `${visibleTypers[0]} is typing...`;
    return;
  }

  typingIndicator.textContent = `${visibleTypers.join(", ")} are typing...`;
}

function createDeleteButton(messageId) {
  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-btn";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", () => {
    socket.emit("delete-message", { messageId });
  });
  return deleteButton;
}

function renderChatMessages(messages) {
  const wasNearBottom =
    chatMessagesContainer.scrollHeight - chatMessagesContainer.scrollTop - chatMessagesContainer.clientHeight < 64;

  chatMessagesContainer.innerHTML = "";

  if (messages.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "chat-empty";
    emptyState.textContent = "No messages yet. Say hello to your server.";
    chatMessagesContainer.appendChild(emptyState);
    return;
  }

  const isOwner = state.currentUserKey === state.roomOwnerKey;

  messages.forEach((message) => {
    const item = document.createElement("article");
    item.className = "chat-item";

    if (message.type === "system") {
      item.classList.add("system");

      const text = document.createElement("p");
      text.className = "chat-system-text";
      text.textContent = `${message.text} - ${formatTime(message.createdAt)}`;
      item.appendChild(text);

      chatMessagesContainer.appendChild(item);
      return;
    }

    if (makeUserKey(message.name) === state.currentUserKey) {
      item.classList.add("own");
    }

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";

    const meta = document.createElement("div");
    meta.className = "chat-meta";

    const author = document.createElement("span");
    author.className = "chat-author";
    author.textContent = makeUserKey(message.name) === state.currentUserKey ? "You" : message.name;

    const metaRight = document.createElement("div");
    metaRight.className = "chat-meta-right";

    const time = document.createElement("span");
    time.textContent = formatTime(message.createdAt);
    metaRight.appendChild(time);

    if (isOwner) {
      metaRight.appendChild(createDeleteButton(message.id));
    }

    meta.append(author, metaRight);

    if (message.type === "file" && message.file) {
      const fileCard = document.createElement("div");
      fileCard.className = "chat-file-card";

      const fileDetails = document.createElement("div");

      const fileName = document.createElement("p");
      fileName.className = "chat-file-name";
      fileName.textContent = message.file.name;

      const fileMeta = document.createElement("p");
      fileMeta.className = "chat-file-meta";
      fileMeta.textContent = `${formatFileSize(message.file.size)}${message.file.mimeType ? ` | ${message.file.mimeType}` : ""}`;

      fileDetails.append(fileName, fileMeta);
      fileCard.append(fileDetails);

      if (message.text) {
        const caption = document.createElement("p");
        caption.className = "chat-file-caption";
        caption.textContent = message.text;
        fileCard.appendChild(caption);
      }

      const fileActions = document.createElement("div");
      fileActions.className = "chat-file-actions";

      const openLink = document.createElement("a");
      openLink.className = "chat-file-link";
      openLink.href = message.file.url;
      openLink.target = "_blank";
      openLink.rel = "noreferrer";
      openLink.textContent = "Open file";

      const downloadLink = document.createElement("a");
      downloadLink.className = "chat-file-link";
      downloadLink.href = message.file.url;
      downloadLink.download = message.file.name;
      downloadLink.textContent = "Download file";

      fileActions.append(openLink, downloadLink);
      bubble.append(meta, fileCard, fileActions);
      item.appendChild(bubble);
      chatMessagesContainer.appendChild(item);
      return;
    }

    const text = document.createElement("p");
    text.className = "chat-text";
    text.textContent = message.text;

    bubble.append(meta, text);
    item.appendChild(bubble);
    chatMessagesContainer.appendChild(item);
  });

  if (wasNearBottom || messages.length <= 1) {
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
  }
}

function isUnreadMessage(message) {
  if (message.type === "system") {
    return true;
  }

  return makeUserKey(message.name) !== state.currentUserKey;
}

function syncChatMessages(messages) {
  const previousIds = new Set(state.chatMessages.map((message) => message.id));
  const newMessages = messages.filter((message) => !previousIds.has(message.id));

  if (newMessages.length > 0 && (!state.chatFocused || document.hidden)) {
    state.unreadCount += newMessages.filter(isUnreadMessage).length;
    renderUnreadBadge();
  }

  state.chatMessages = messages;
  state.chatSignature = getChatSignature(messages);
  renderChatMessages(messages);

  if (state.chatFocused && !document.hidden) {
    resetUnreadCount();
  }
}

function renderMembers(users) {
  membersList.innerHTML = "";

  if (users.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "member-meta";
    emptyState.textContent = "No one is in the server yet.";
    membersList.appendChild(emptyState);
    return;
  }

  const current = currentUser();
  const isOwner = state.currentUserKey === state.roomOwnerKey;
  const activeSharer = getActiveSharingUser();

  users.forEach((user) => {
    const card = document.createElement("article");
    card.className = "member-card";

    const address = user.location?.address || "This member has not shared a location yet.";
    const distance =
      current?.location && user.location && current.userKey !== user.userKey
        ? distanceInMeters(current.location, user.location)
        : null;
    const head = document.createElement("div");
    head.className = "member-head";

    const identity = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = `${user.name}${user.userKey === state.currentUserKey ? " (You)" : ""}`;

    const joined = document.createElement("p");
    joined.className = "member-meta";
    joined.textContent = `Joined ${formatDate(user.joinedAt)}`;
    identity.append(title, joined);

    const badgeGroup = document.createElement("div");
    badgeGroup.className = "member-badges";

    const presenceBadge = document.createElement("span");
    presenceBadge.className = `presence-pill ${user.online ? "online" : "offline"}`;
    presenceBadge.textContent = user.online ? "Online" : "Offline";
    badgeGroup.appendChild(presenceBadge);

    const sharingBadge = document.createElement("span");
    sharingBadge.className = `status-pill ${user.isSharing ? "live" : "idle"}`;
    sharingBadge.textContent = user.isSharing ? "Live sharing" : "Last known";
    badgeGroup.appendChild(sharingBadge);

    if (user.isOwner) {
      const ownerPill = document.createElement("span");
      ownerPill.className = "security-badge";
      ownerPill.textContent = "Owner";
      badgeGroup.appendChild(ownerPill);
    }

    if (user.isTyping) {
      const typingBadge = document.createElement("span");
      typingBadge.className = "status-pill typing";
      typingBadge.textContent = "Typing";
      badgeGroup.appendChild(typingBadge);
    }

    head.append(identity, badgeGroup);

    const addressLine = document.createElement("p");
    addressLine.className = "member-address";
    addressLine.textContent = address;

    const updatedLine = document.createElement("p");
    updatedLine.className = "member-meta";
    updatedLine.textContent = user.location ? `Updated ${formatRelativeTime(user.location.updatedAt)}` : "No saved location yet";

    const presenceLine = document.createElement("p");
    presenceLine.className = "member-meta";
    presenceLine.textContent = user.online ? "Currently connected" : `Last seen ${formatRelativeTime(user.lastSeenAt)}`;

    const routeLine = document.createElement("p");
    routeLine.className = "member-meta";
    routeLine.textContent = user.route?.length ? `${user.route.length} route points saved` : "No route history yet";

    const distanceLine = document.createElement("p");
    distanceLine.className = "member-meta";
    distanceLine.textContent =
      distance !== null && Number.isFinite(distance) ? `Distance from you: ${formatDistanceMeters(distance)}` : "";

    const actions = document.createElement("div");
    actions.className = "member-actions";

    card.append(head, addressLine, updatedLine, presenceLine, routeLine);

    if (distanceLine.textContent) {
      card.appendChild(distanceLine);
    }

    card.appendChild(actions);

    const focusButton = document.createElement("button");
    focusButton.className = "small-btn";
    focusButton.type = "button";
    if (activeSharer?.userKey === user.userKey) {
      focusButton.textContent = "Shared with room";
      focusButton.disabled = true;
    } else if (activeSharer) {
      focusButton.textContent = "Map locked live";
      focusButton.disabled = true;
    } else {
      focusButton.textContent = "Map blank";
      focusButton.disabled = true;
    }
    actions.appendChild(focusButton);

    if (user.location) {
      const openLink = document.createElement("a");
      openLink.className = "small-btn";
      openLink.href = buildGoogleMapsUrl(user.location.latitude, user.location.longitude);
      openLink.target = "_blank";
      openLink.rel = "noreferrer";
      openLink.textContent = "Google Maps";
      actions.appendChild(openLink);

      const directionsAnchor = document.createElement("a");
      directionsAnchor.className = "small-btn";
      directionsAnchor.href = buildDirectionsUrl(
        current?.location && current.userKey !== user.userKey ? current.location : null,
        user.location
      );
      directionsAnchor.target = "_blank";
      directionsAnchor.rel = "noreferrer";
      directionsAnchor.textContent = "Directions";
      actions.appendChild(directionsAnchor);
    }

    if (isOwner && user.online && !user.isOwner && user.sessionId) {
      const kickButton = document.createElement("button");
      kickButton.className = "kick-btn";
      kickButton.type = "button";
      kickButton.textContent = "Kick user";
      kickButton.addEventListener("click", () => {
        socket.emit("kick-user", { sessionId: user.sessionId });
      });
      actions.appendChild(kickButton);
    }

    membersList.appendChild(card);
  });
}

function handleRoomState(roomState) {
  state.currentRoomName = roomState.roomName;
  state.currentRoomKey = roomState.roomKey;
  state.roomOwnerName = roomState.ownerName;
  state.roomOwnerKey = roomState.ownerKey;
  state.roomInviteToken = roomState.inviteToken;
  state.roomLocked = Boolean(roomState.isLocked);
  state.roomUsers = roomState.users || [];

  roomPanel.classList.remove("hidden");
  renderTopBar();
  renderInviteCard();
  renderAdminPanel();
  renderTypingIndicator(roomState.typingUsers || []);
  renderMembers(state.roomUsers);
  renderMap();
  syncChatMessages(roomState.messages || []);
}

function emitJoin(eventName) {
  const payload = sanitizeForm();
  const usingInvite = shouldUsePendingInvite(payload.roomName);

  if (!payload.userName || payload.userName.length < 2) {
    setMessage(entryMessage, "Enter a name with at least 2 characters.", "error");
    return;
  }

  if (eventName === "create-server") {
    if (!payload.roomName || payload.roomName.length < 2) {
      setMessage(entryMessage, "Enter a server name with at least 2 characters.", "error");
      return;
    }

    if (!payload.password || payload.password.length < 4) {
      setMessage(entryMessage, "Use a password with at least 4 characters.", "error");
      return;
    }
  }

  if (eventName === "join-server") {
    if (!payload.roomName && !usingInvite) {
      setMessage(entryMessage, "Enter the server name or open a valid invite link.", "error");
      return;
    }

    if (!payload.password && !usingInvite) {
      setMessage(entryMessage, "Enter the server password or use a valid invite link.", "error");
      return;
    }
  }

  state.currentUserName = payload.userName;
  state.currentUserKey = makeUserKey(payload.userName);

  socket.emit(eventName, {
    ...payload,
    inviteToken: eventName === "join-server" && usingInvite ? state.pendingInviteToken : ""
  });
}

function sendTypingState(isTyping) {
  if (!state.currentRoomKey) {
    return;
  }

  if (state.typingState === isTyping) {
    return;
  }

  state.typingState = isTyping;
  socket.emit("typing-state", { isTyping });
}

function scheduleTypingStop() {
  clearTypingStopTimer();
  state.typingStopTimer = window.setTimeout(() => {
    sendTypingState(false);
  }, 1200);
}

function stopSharing(resetStatus = true) {
  const wasWaitingForAccess = state.shareRequestPending && state.watchId === null;
  state.shareRequestPending = false;

  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  shareButton.disabled = false;
  stopButton.disabled = true;

  if (state.currentRoomKey) {
    socket.emit("sharing-state", { isSharing: false });
  }

  if (resetStatus) {
    setMessage(
      shareStatus,
      wasWaitingForAccess
        ? "Your live sharing request was canceled."
        : "Live sharing stopped. Your last shared location stays visible until you move again or leave.",
      "success"
    );
  }
}

function shouldRefreshAddress(latitude, longitude) {
  const now = Date.now();
  const currentPoint = { latitude, longitude };
  const movedFarEnough = distanceInMeters(state.lastGeocodePoint, currentPoint) > 75;
  const enoughTimePassed = now - state.lastGeocodeTime > 30000;
  return !state.lastGeocodePoint || movedFarEnough || enoughTimePassed;
}

function emitLocation(latitude, longitude, address) {
  socket.emit("location-update", {
    latitude,
    longitude,
    address,
    updatedAt: new Date().toISOString()
  });
}

async function refreshAddress(latitude, longitude) {
  const requestId = ++state.geocodeRequestId;

  try {
    const address = await reverseGeocode(latitude, longitude);
    if (requestId !== state.geocodeRequestId) {
      return;
    }

    state.lastAddress = address;
    state.lastGeocodeTime = Date.now();
    state.lastGeocodePoint = { latitude, longitude };
    emitLocation(latitude, longitude, address);
    setMessage(shareStatus, "Live sharing is active and your latest address is synced.", "success");
  } catch (_error) {
    if (!state.lastAddress) {
      setMessage(shareStatus, "Location is sharing, but the address lookup is temporarily unavailable.", "error");
    }
  }
}

function beginApprovedSharing() {
  if (!state.currentRoomKey) {
    state.shareRequestPending = false;
    return;
  }

  if (state.watchId !== null) {
    return;
  }

  state.shareRequestPending = false;
  shareButton.disabled = true;
  stopButton.disabled = false;
  setMessage(shareStatus, "Waiting for location permission and your first update...", "success");

  state.watchId = navigator.geolocation.watchPosition(
    (position) => {
      const latitude = Number(position.coords.latitude.toFixed(6));
      const longitude = Number(position.coords.longitude.toFixed(6));

      emitLocation(latitude, longitude, state.lastAddress || "Resolving address...");
      setMessage(shareStatus, "Coordinates are live. Resolving your current address...", "success");

      if (shouldRefreshAddress(latitude, longitude)) {
        refreshAddress(latitude, longitude);
      }
    },
    (error) => {
      stopSharing(false);

      const messageByCode = {
        1: "Location permission was denied.",
        2: "Location information is unavailable right now.",
        3: "Location request timed out."
      };

      setMessage(shareStatus, messageByCode[error.code] || "Unable to access your location.", "error");
    },
    {
      enableHighAccuracy: true,
      maximumAge: 8000,
      timeout: 15000
    }
  );
}

function startSharing() {
  if (!navigator.geolocation) {
    setMessage(shareStatus, "This browser does not support geolocation.", "error");
    return;
  }

  if (!state.currentRoomKey) {
    setMessage(shareStatus, "Join a server before sharing your location.", "error");
    return;
  }

  if (state.watchId !== null) {
    setMessage(shareStatus, "Live sharing is already running.", "success");
    return;
  }

  if (state.shareRequestPending) {
    setMessage(shareStatus, "Waiting for the current live sharer to finish. Try again in a moment.", "warning");
    return;
  }

  state.shareRequestPending = true;
  shareButton.disabled = true;
  stopButton.disabled = true;
  setMessage(shareStatus, "Checking if the live map is free for you...", "success");
  socket.emit("request-share-start");
}

function sendChatMessage(event) {
  event.preventDefault();

  if (!state.currentRoomKey) {
    setMessage(chatStatus, "Join a server before sending messages.", "error");
    return;
  }

  if (state.isUploading) {
    setMessage(chatStatus, "Wait for the current upload to finish first.", "error");
    return;
  }

  const text = chatInput.value.trim();
  if (!text) {
    setMessage(chatStatus, "Type a message before sending.", "error");
    return;
  }

  if (text.length > MAX_CHAT_LENGTH) {
    setMessage(chatStatus, `Messages can be up to ${MAX_CHAT_LENGTH} characters.`, "error");
    return;
  }

  socket.emit("send-message", { text });
  sendTypingState(false);
  clearTypingStopTimer();
  chatInput.value = "";
  setMessage(chatStatus, "");
}

async function uploadChatFile(file) {
  if (state.isUploading) {
    setMessage(chatStatus, "Wait for the current upload to finish first.", "error");
    chatFileInput.value = "";
    return;
  }

  if (!state.currentRoomKey || !state.uploadToken) {
    setMessage(chatStatus, "Join a server before uploading files.", "error");
    chatFileInput.value = "";
    return;
  }

  if (!file) {
    setMessage(chatStatus, "Choose a file before uploading.", "error");
    return;
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    setMessage(chatStatus, "Files can be up to 100 GB.", "error");
    chatFileInput.value = "";
    return;
  }

  const caption = chatInput.value.trim();
  if (caption.length > MAX_CHAT_LENGTH) {
    setMessage(chatStatus, `Captions can be up to ${MAX_CHAT_LENGTH} characters.`, "error");
    chatFileInput.value = "";
    return;
  }

  setUploadUiActive(true);
  updateUploadProgress(file.name, 0, file.size);
  setMessage(chatStatus, `Uploading ${file.name}...`, "success");

  try {
    await uploadFileRequest(file, caption);
    chatInput.value = "";
    setMessage(chatStatus, `${file.name} uploaded to chat.`, "success");
    scheduleUploadProgressReset();
  } catch (error) {
    setMessage(chatStatus, error.message || "Unable to upload this file.", "error");
    resetUploadProgress();
  } finally {
    setUploadUiActive(false);
    chatFileInput.value = "";
  }
}

function handleFileSelection(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  uploadChatFile(file);
}

function resetMapLayers() {
  mapCanvas.hidden = true;
  mapCanvas.removeAttribute("src");
}

function resetRoomUi() {
  roomPanel.classList.add("hidden");
  state.currentRoomName = "";
  state.currentRoomKey = "";
  state.roomOwnerName = "";
  state.roomOwnerKey = "";
  state.roomInviteToken = "";
  state.roomLocked = false;
  state.uploadToken = "";
  state.roomUsers = [];
  state.chatMessages = [];
  state.chatSignature = "";
  state.isUploading = false;
  state.chatFocused = false;
  state.typingState = false;
  state.shareRequestPending = false;
  state.selectedUserKey = "";
  state.lastAddress = "";
  state.lastGeocodeTime = 0;
  state.lastGeocodePoint = null;
  state.geocodeRequestId = 0;
  stopSharing(false);
  clearTypingStopTimer();
  sendTypingState(false);
  resetUnreadCount();
  setUploadUiActive(false);
  resetUploadProgress();
  resetMapLayers();

  roomTitle.textContent = "Server";
  roomSubtitle.textContent = "Private room with live location and chat.";
  ownerBadge.classList.add("hidden");
  lockBadge.textContent = "Unlocked";
  capacityBadge.textContent = `0 / ${MAX_USERS_PER_SERVER} users`;
  membersList.innerHTML = "";
  chatMessagesContainer.innerHTML = "";
  routeList.innerHTML = "";
  routeSummary.textContent = "Select a member to view route history, recent stops, and directions.";
  typingIndicator.textContent = "No one is typing right now.";
  mapTitle.textContent = "Pick a member";
  mapEmpty.hidden = false;
  setMapLinkState(mapsLink, "#");
  setMapLinkState(directionsLink, "#");
  inviteLinkInput.value = "";
  openInviteButton.href = "#";
  inviteQrImage.removeAttribute("src");
  inviteNote.textContent = "Invite details will appear after you join a server.";
  adminPanel.classList.add("hidden");
  adminPasswordInput.value = "";
  chatInput.value = "";
  chatFileInput.value = "";
  setMessage(shareStatus, "");
  setMessage(chatStatus, "");
  setMessage(inviteStatus, "");
  setMessage(adminStatus, "");
}

createButton.addEventListener("click", () => emitJoin("create-server"));
joinButton.addEventListener("click", () => emitJoin("join-server"));

entryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  emitJoin("join-server");
});

chatForm.addEventListener("submit", sendChatMessage);

chatInput.addEventListener("focus", () => {
  state.chatFocused = true;
  resetUnreadCount();
});

chatInput.addEventListener("blur", () => {
  state.chatFocused = false;
  sendTypingState(false);
  clearTypingStopTimer();
});

chatInput.addEventListener("input", () => {
  if (!chatInput.value.trim()) {
    sendTypingState(false);
    clearTypingStopTimer();
    return;
  }

  sendTypingState(true);
  scheduleTypingStop();
});

chatMessagesContainer.addEventListener("click", () => {
  state.chatFocused = true;
  resetUnreadCount();
});

chatFileButton.addEventListener("click", () => {
  chatFileInput.click();
});

chatFileInput.addEventListener("change", handleFileSelection);

shareButton.addEventListener("click", startSharing);
stopButton.addEventListener("click", () => stopSharing(true));

leaveButton.addEventListener("click", () => {
  stopSharing(false);
  socket.emit("leave-server");
  resetRoomUi();
  setMessage(entryMessage, "You left the server.", "success");
});

copyInviteButton.addEventListener("click", async () => {
  if (!inviteLinkInput.value) {
    setMessage(inviteStatus, "Join a server first to copy the invite link.", "error");
    return;
  }

  try {
    await copyTextToClipboard(inviteLinkInput.value);
    setMessage(inviteStatus, "Invite link copied.", "success");
  } catch (_error) {
    setMessage(inviteStatus, "Unable to copy the invite link.", "error");
  }
});

lockButton.addEventListener("click", () => {
  socket.emit("toggle-lock");
});

changePasswordButton.addEventListener("click", () => {
  const password = adminPasswordInput.value.trim();
  if (password.length < 4) {
    setMessage(adminStatus, "Use a password with at least 4 characters.", "error");
    return;
  }

  socket.emit("change-password", { password });
  adminPasswordInput.value = "";
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.currentRoomKey) {
    resetUnreadCount();
  }
});

window.addEventListener("focus", () => {
  if (state.currentRoomKey) {
    resetUnreadCount();
  }
});

socket.on("joined-room", (payload) => {
  state.currentUserName = payload.userName;
  state.currentUserKey = makeUserKey(payload.userName);
  state.currentRoomName = payload.roomName;
  state.currentRoomKey = payload.roomKey;
  state.uploadToken = payload.uploadToken || "";
  state.shareRequestPending = false;

  passwordInput.value = "";
  chatInput.value = "";
  chatFileInput.value = "";
  setUploadUiActive(false);
  resetUploadProgress();
  setMessage(chatStatus, "");
  setMessage(entryMessage, `Connected to ${payload.roomName}.`, "success");
});

socket.on("room-state", (roomState) => {
  handleRoomState(roomState);
});

socket.on("join-error", (message) => {
  setMessage(entryMessage, message, "error");
});

socket.on("chat-error", (message) => {
  setMessage(chatStatus, message, "error");
});

socket.on("share-error", (message) => {
  if (state.shareRequestPending && state.watchId === null) {
    state.shareRequestPending = false;
    shareButton.disabled = false;
    stopButton.disabled = true;
  }
  setMessage(shareStatus, message, "error");
});

socket.on("share-start-approved", (message) => {
  beginApprovedSharing();
  setMessage(shareStatus, message || "Map access granted. Start moving to update your location.", "success");
});

socket.on("share-blocked", (message) => {
  state.shareRequestPending = false;
  if (state.watchId !== null) {
    stopSharing(false);
  } else {
    shareButton.disabled = false;
    stopButton.disabled = true;
  }
  setMessage(shareStatus, message, "error");
});

socket.on("share-warning", (message) => {
  setMessage(shareStatus, message, "warning");
});

socket.on("admin-error", (message) => {
  setMessage(adminStatus, message, "error");
});

socket.on("admin-feedback", (message) => {
  setMessage(adminStatus, message, "success");
});

socket.on("forced-leave", (message) => {
  resetRoomUi();
  setMessage(entryMessage, message, "error");
});

socket.on("left-room", () => {
  resetRoomUi();
});

socket.on("server-error", (message) => {
  setMessage(entryMessage, message, "error");
});

loadInviteFromUrl();
renderUnreadBadge();
