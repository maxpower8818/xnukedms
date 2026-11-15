/* Inbox parsing and delete selection for X Nuke DMs.
   Works in the extension and in Node. Conversation text is never read. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XNukeInbox = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const BUCKETS = [
    { id: "primary", name: "Primary" },
    { id: "requests", name: "Requests" },
    { id: "hidden", name: "Hidden requests" },
    { id: "groups", name: "Groups" }
  ];

  const BUCKET_NAME = {
    primary: "Primary",
    requests: "Requests",
    hidden: "Hidden requests",
    groups: "Groups"
  };

  const TIMELINES = [
    { id: "trusted", path: "trusted", quality: "" },
    { id: "untrusted", path: "untrusted", quality: "high" },
    { id: "untrusted_low_quality", path: "untrusted", quality: "low" }
  ];

  function asTimeMs(value) {
    if (value == null || value === "") return null;
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) return null;
    if (raw.length >= 16) {
      try {
        const ms = (BigInt(raw) >> 22n) + 1288834974657n;
        const n = Number(ms);
        return Number.isSafeInteger(n) ? n : null;
      } catch (error) {
        return null;
      }
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (raw.length >= 12) return n;
    if (raw.length >= 10) return n * 1000;
    return null;
  }

  function readableName(name) {
    const text = String(name || "").trim();
    if (!text || text.length > 80) return "";
    if (/\s/.test(text)) return text;
    if (/^[A-Za-z0-9+/_-]+=*$/.test(text) && text.length >= 16) return "";
    return text;
  }

  function bucketFor(conv) {
    if (!conv) return "primary";
    if (conv.type === "GROUP" || conv.bucket === "groups") return "groups";
    if (conv.bucket && BUCKET_NAME[conv.bucket]) return conv.bucket;
    if (conv.trusted) return "primary";
    if (conv.lowQuality || conv.muted) return "hidden";
    return "requests";
  }

  function userRecord(id, user) {
    const source = user || {};
    return {
      id: String(source.id_str || source.id || id || ""),
      name: typeof source.name === "string" ? source.name : "",
      handle: typeof source.screen_name === "string" ? source.screen_name : ""
    };
  }

  function readLegacyUsers(root) {
    const users = {};
    const raw = root && root.users;
    if (!raw) return users;
    if (Array.isArray(raw)) {
      for (const user of raw) {
        const record = userRecord(user && (user.id_str || user.id), user);
        if (record.id) users[record.id] = record;
      }
      return users;
    }
    if (typeof raw === "object") {
      for (const id of Object.keys(raw)) {
        const record = userRecord(id, raw[id]);
        if (record.id) users[record.id] = record;
      }
    }
    return users;
  }

  function readLegacyConversations(root) {
    const map = root && root.conversations;
    if (!map || typeof map !== "object" || Array.isArray(map)) return [];
    const list = [];
    for (const key of Object.keys(map)) {
      const raw = map[key];
      if (!raw || typeof raw !== "object") continue;
      const id = String(raw.conversation_id || key || "");
      if (!id) continue;
      const participants = Array.isArray(raw.participants) ? raw.participants : [];
      const type = raw.type === "GROUP_DM" || raw.type === "GROUP" ? "GROUP" : "DIRECT";
      list.push({
        id,
        type,
        trusted: !!raw.trusted,
        lowQuality: !!raw.low_quality,
        muted: !!raw.muted,
        sortAt: asTimeMs(raw.sort_timestamp),
        name: typeof raw.name === "string" ? raw.name : "",
        participantIds: participants
          .map((participant) => String(participant.user_id_str || participant.user_id || ""))
          .filter(Boolean),
        source: "legacy"
      });
    }
    return list;
  }

  function cursorsFromInitial(root) {
    const timelines = (root && root.inbox_timelines) || {};
    const cursors = {};
    for (const timeline of TIMELINES) {
      const raw = timelines[timeline.id];
      cursors[timeline.id] = raw
        ? {
          status: raw.status || "AT_END",
          minEntryId: raw.min_entry_id != null ? String(raw.min_entry_id) : ""
        }
        : { status: "AT_END", minEntryId: "" };
    }
    return cursors;
  }

  function pageCursor(root) {
    if (!root) return { status: "AT_END", minEntryId: "" };
    return {
      status: root.status || "",
      minEntryId: root.min_entry_id != null && root.min_entry_id !== "" ? String(root.min_entry_id) : ""
    };
  }

  function parseLegacyPage(json) {
    const root = json && (json.inbox_initial_state || json.inbox_timeline);
    if (!root || typeof root !== "object") return null;
    return {
      conversations: readLegacyConversations(root),
      users: readLegacyUsers(root),
      initialCursors: root.inbox_timelines ? cursorsFromInitial(root) : null,
      pageCursor: pageCursor(root)
    };
  }

  function cursorMoved(previousId, next) {
    if (!next || !next.minEntryId) return false;
    if (next.status === "AT_END") return false;
    return next.minEntryId !== previousId;
  }

function readXchatUser(node) {
    if (!node || typeof node !== "object") return null;
    const wrapped = node.user_results && typeof node.user_results === "object" ? node.user_results : node;
    const user = wrapped.result && typeof wrapped.result === "object" ? wrapped.result : wrapped;
    const id = asId(node.rest_id) || asId(wrapped.rest_id) || asId(user.rest_id) || asId(node.user_id) || asId(node.user_id_str);
    if (!id) return null;
    const core = user.core || {};
    return {
      id,
      name: typeof core.name === "string" ? core.name : "",
      handle: typeof core.screen_name === "string" ? core.screen_name : ""
    };
  }

  function rememberUser(users, user) {
    if (!user || !user.id) return;
    const prev = users[user.id];
    if (!prev) {
      users[user.id] = user;
      return;
    }
    users[user.id] = {
      id: user.id,
      name: user.name || prev.name,
      handle: user.handle || prev.handle
    };
  }

  function xchatPage(json) {
    const data = json && (json.data || json);
    if (!data || typeof data !== "object") return null;
    return data.get_initial_chat_page || data.get_inbox_page || null;
  }

  function asId(value) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
  }

  function nestedConversationId(value, depth) {
    if (!value || typeof value !== "object" || depth > 6) return "";
    const direct = asId(value.conversation_id) || asId(value.conversationId);
    if (direct && validConversationId(direct)) return direct;
    const entries = Array.isArray(value) ? value.slice(0, 8) : Object.keys(value).slice(0, 40);
    for (let i = 0; i < entries.length; i += 1) {
      const child = Array.isArray(value) ? entries[i] : value[entries[i]];
      if (!child || typeof child !== "object") continue;
      const found = nestedConversationId(child, depth + 1);
      if (found) return found;
    }
    return "";
  }

  function outlineKeys(value, depth) {
    if (!value || typeof value !== "object" || depth > 2) return "";
    const keys = Object.keys(value).slice(0, 16);
    return keys.map((key) => {
      if (redactKey(key)) return key;
      const child = value[key];
      if (/^(conversation_id|conversationId|__typename|is_deleted_by_viewer|is_archived|is_muted|has_more|rest_id)$/.test(key)) {
        if (child == null || child === "") return `${key}=null`;
        if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
          return `${key}=${String(child).slice(0, 64)}`;
        }
      }
      if (Array.isArray(child)) return `${key}[${child.length}]`;
      if (child && typeof child === "object") {
        const inner = outlineKeys(child, depth + 1);
        return inner ? `${key}{${inner}}` : key;
      }
      return key;
    }).join(",");
  }

  function collectParticipantIds(value, users, depth, ids) {
    if (!value || typeof value !== "object" || depth > 5) return;
    const user = readXchatUser(value);
    if (user && /^\d+$/.test(user.id)) {
      rememberUser(users, user);
      ids.push(user.id);
    }
    const list = Array.isArray(value) ? value : Object.keys(value);
    for (let i = 0; i < list.length && i < 40; i += 1) {
      const key = Array.isArray(value) ? i : list[i];
      if (!Array.isArray(value) && (redactKey(key) || /prompt|metadata|cursor|message/i.test(String(key)))) continue;
      const child = value[key];
      if (child && typeof child === "object") collectParticipantIds(child, users, depth + 1, ids);
    }
  }

  function xchatItemRoot(item) {
    return item && item.node && typeof item.node === "object" ? item.node : item;
  }

  function xchatItemDetail(root) {
    if (!root || typeof root !== "object") return root;
    if (root.conversation_detail && typeof root.conversation_detail === "object") return root.conversation_detail;
    if (root.conversation && typeof root.conversation === "object") return root.conversation;
    return root;
  }

  function participantIdsFor(detail, root, users) {
    const participantIds = [];
    const lists = [detail && detail.participants_results, detail && detail.group_members_results, root && root.participants_results]
      .filter((list) => Array.isArray(list) && list.length);
    if (lists.length) {
      for (const list of lists) collectParticipantIds(list, users, 0, participantIds);
    } else if (detail && typeof detail === "object") {
      collectParticipantIds(detail === root ? root : detail, users, 0, participantIds);
      if (!participantIds.length && detail !== root) collectParticipantIds(root, users, 0, participantIds);
    }
    return [...new Set(participantIds)];
  }

  function itemDebug(item, rawId, participantIds, selfId) {
    const root = xchatItemRoot(item);
    const detail = xchatItemDetail(root);
    const deleted = !!(item && item.is_deleted_by_viewer === true) || !!(root && root.is_deleted_by_viewer === true);
    const typeName = asId(detail && detail.__typename) || asId(root && root.__typename) || "none";
    const parts = participantIds.slice(0, 4).join("+") || "none";
    const outline = outlineKeys(item && (item.node || item));
    return `deleted=${deleted} type=${typeName} id=${rawId || "null"} participants=${parts} self=${selfId || "none"}${outline ? ` outline ${outline}` : ""}`;
  }

  function readXchatItem(item, users, selfId) {
    if (item == null) return { conv: null, reason: "null", detail: "item=null" };
    if (typeof item !== "object") return { conv: null, reason: "not-object", detail: `type=${typeof item}` };
    const root = xchatItemRoot(item);
    const detail = xchatItemDetail(root);
    const participantIds = participantIdsFor(detail, root, users);
    const rawId = asId(detail && detail.conversation_id) || asId(root && root.conversation_id) || nestedConversationId(root, 0);
    let id = rawId;
    if (!validConversationId(id)) id = pairConversationId(participantIds, selfId);
    const detailText = itemDebug(item, rawId, participantIds, selfId);
    if (!id || !validConversationId(id)) {
      return { conv: null, reason: rawId ? "invalid-id" : "no-id", detail: detailText };
    }
    const meta = detail.group_metadata || root.group_metadata || {};
    const isGroup = detail.__typename === "XChatGroupConversationDetail"
      || root.__typename === "XChatGroupConversationDetail"
      || id.startsWith("g");
    return {
      conv: {
        id,
        type: isGroup ? "GROUP" : "DIRECT",
        trusted: true,
        lowQuality: false,
        muted: !!(detail.is_muted || root.is_muted),
        sortAt: asTimeMs(meta.updated_at_msec || meta.created_at_msec || detail.updated_at_msec || root.updated_at_msec),
        name: typeof meta.group_name === "string" ? meta.group_name : "",
        participantIds,
        deletedByViewer: root.is_deleted_by_viewer === true || item.is_deleted_by_viewer === true,
        source: "xchat"
      },
      reason: "",
      detail: ""
    };
  }

  function summarizeSkips(skips) {
    const counts = new Map();
    const samples = new Map();
    for (const skip of skips) {
      counts.set(skip.reason, (counts.get(skip.reason) || 0) + 1);
      if (!samples.has(skip.reason)) samples.set(skip.reason, skip.detail);
    }
    const tally = [...counts].map(([reason, count]) => `${reason}=${count}`).join(",");
    const sample = [...samples].slice(0, 2).map(([reason, detail]) => `${reason}{${detail}}`).join(" ");
    return `${tally} ${sample}`.trim();
  }

  function parseXchatPage(json, selfId) {
    const page = xchatPage(json);
    if (!page) return null;
    const users = {};
    const conversations = [];
    const items = Array.isArray(page.items) ? page.items : [];
    const skips = [];
    for (const item of items) {
      const read = readXchatItem(item, users, selfId);
      if (read.conv) conversations.push(read.conv);
      else skips.push(read);
    }
    const skippedOutline = summarizeSkips(skips);
    const pageKeys = Object.keys(page).filter((key) => !redactKey(key)).slice(0, 14).join(",");
    const cursorNode = page.inboxCursor || page.cursor || null;
    let cursor = null;
    if (cursorNode && typeof cursorNode === "object") {
      if (cursorNode.inbox_exhausted || cursorNode.__typename === "XChatGetInboxPageEndCursor") {
        cursor = { done: true, cursorId: "", snapshotId: "" };
      } else if (cursorNode.cursor_id) {
        cursor = {
          done: false,
          cursorId: String(cursorNode.cursor_id),
          snapshotId: cursorNode.graph_snapshot_id ? String(cursorNode.graph_snapshot_id) : ""
        };
      }
    }
    return { conversations, users, cursor, itemCount: items.length, skippedOutline, pageKeys };
  }

  function createIndex() {
    return { conversations: new Map(), users: {} };
  }

  function mergeParsed(index, parsed) {
    if (!index || !parsed) return 0;
    for (const id of Object.keys(parsed.users || {})) rememberUser(index.users, parsed.users[id]);
    let added = 0;
    for (const conv of parsed.conversations || []) {
      const prev = index.conversations.get(conv.id);
      if (!prev) {
        added += 1;
        index.conversations.set(conv.id, conv);
        continue;
      }
      index.conversations.set(conv.id, {
        ...prev,
        ...conv,
        sortAt: conv.sortAt || prev.sortAt,
        name: readableName(conv.name) ? conv.name : (prev.name || conv.name),
        participantIds: conv.participantIds && conv.participantIds.length ? conv.participantIds : prev.participantIds,
        source: prev.source === "xchat" || conv.source === "xchat" ? "xchat" : (conv.source || prev.source)
      });
    }
    return added;
  }

  function selfIdFromCookie(cookie) {
    const match = String(cookie || "").match(/(?:^|;\s*)twid=([^;]+)/);
    if (!match) return "";
    let value = match[1];
    try {
      value = decodeURIComponent(value);
    } catch (error) {
      /* keep the raw cookie value */
    }
    const id = value.match(/u=(\d+)/);
    return id ? id[1] : "";
  }

  function inferSelfId(conversations) {
    const counts = new Map();
    for (const conv of conversations) {
      if (!conv || conv.type !== "DIRECT") continue;
      for (const id of conv.participantIds || []) {
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    let best = "";
    let bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount) {
        best = id;
        bestCount = count;
      }
    }
    return bestCount >= 2 ? best : "";
  }

  function labelFor(conv, users, selfId) {
    if (!conv) return "Conversation";
    if (conv.type === "GROUP" || conv.bucket === "groups") {
      const name = readableName(conv.name);
      if (name) return name;
      const count = (conv.participantIds || []).length;
      return count ? `Group · ${count}` : "Group";
    }
    const other = (conv.participantIds || []).find((id) => id && id !== selfId) || (conv.participantIds || [])[0] || "";
    const user = other && users ? users[other] : null;
    if (!user) return other ? `User ${other}` : "Direct message";
    const handle = user.handle ? `@${user.handle}` : "";
    if (user.name && handle) return `${user.name} ${handle}`;
    return user.name || handle || `User ${other}`;
  }

  function whenLabel(sortAt, now) {
    if (!sortAt) return "no date";
    const days = Math.floor((now - sortAt) / 86400000);
    if (days < 1) return "today";
    if (days === 1) return "1 day ago";
    if (days < 365) return `${days} days ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? "1 year ago" : `${years} years ago`;
  }

  function presentConversation(conv, users, selfId, now) {
    const bucket = bucketFor(conv);
    return {
      id: conv.id,
      label: labelFor(conv, users, selfId),
      bucket,
      bucketName: BUCKET_NAME[bucket] || bucket,
      when: whenLabel(conv.sortAt, now),
      sortAt: conv.sortAt || null,
      source: conv.source || "",
      type: conv.type || "DIRECT"
    };
  }

  function matchesFilter(conv, filter, now) {
    const settings = filter || {};
    const allowed = Array.isArray(settings.buckets) && settings.buckets.length
      ? settings.buckets
      : BUCKETS.map((bucket) => bucket.id);
    if (!allowed.includes(bucketFor(conv))) return false;
    const days = Number(settings.olderThanDays);
    if (Number.isFinite(days) && days > 0) {
      if (!conv.sortAt) return false;
      if (conv.sortAt > now - days * 86400000) return false;
    }
    const query = String(settings.query || "").trim().toLowerCase();
    if (!query) return true;
    return String(conv.label || labelFor(conv, settings.users || {}, settings.selfId || "")).toLowerCase().includes(query);
  }

  function retryWaitMs(status, resetEpochSeconds, nowMs) {
    if (status !== 429 && status !== 420) return 0;
    const resetMs = Number(resetEpochSeconds) * 1000;
    if (Number.isFinite(resetMs) && resetMs > nowMs) {
      return Math.min(resetMs - nowMs + 1000, 15 * 60 * 1000);
    }
    return 60 * 1000;
  }

  function clampDelay(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1200;
    return Math.min(5000, Math.max(500, Math.round(n)));
  }

  function validConversationId(id) {
    return typeof id === "string" && id !== "null" && /^[A-Za-z0-9_:-]+$/.test(id) && id.length <= 80;
  }

  function compareNumericIds(a, b) {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function pairConversationId(participantIds, selfId) {
    const ids = [];
    const add = (value) => {
      const id = asId(value);
      if (!/^\d+$/.test(id) || ids.includes(id)) return;
      ids.push(id);
    };
    for (const id of participantIds) add(id);
    add(selfId);
    const self = asId(selfId);
    if (ids.length === 1 && self && ids[0] === self) {
      const own = `${ids[0]}:${ids[0]}`;
      return validConversationId(own) ? own : "";
    }
    if (ids.length !== 2) return "";
    ids.sort(compareNumericIds);
    const id = `${ids[0]}:${ids[1]}`;
    return validConversationId(id) ? id : "";
  }

  function conversationIdForms(id) {
    const raw = String(id || "");
    const forms = [];
    const add = (value) => {
      if (value && forms.indexOf(value) === -1) forms.push(value);
    };
    add(raw);
    const parts = raw.split(":");
    if (parts.length === 2 && parts[0] && parts[1]) {
      add(`${parts[1]}:${parts[0]}`);
      add(`${parts[0]}-${parts[1]}`);
      add(`${parts[1]}-${parts[0]}`);
    }
    return forms;
  }

  function responseError(json) {
    if (!json || typeof json !== "object") return "";
    if (Array.isArray(json.errors) && json.errors.length) {
      return json.errors.map((error) => error && (error.message || error.code) || "error").join("; ");
    }
    if (typeof json.error === "string") return json.error;
    if (json.errors && typeof json.errors === "string") return json.errors;
    return "";
  }

  function redactKey(key) {
    return /encoded|ciphertext|token|authorization|cookie|signature|secret|contents|message_event|message_create|^text$/i.test(String(key || ""));
  }

  function summarizeValue(value, depth) {
    if (value == null) return "null";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "string") {
      return value.length > 160 ? `"${value.slice(0, 80)}…"` : JSON.stringify(value);
    }
    if (depth > 3) return Array.isArray(value) ? `[${value.length}]` : "{…}";
    if (Array.isArray(value)) {
      if (!value.length) return "[]";
      const shown = value.slice(0, 3).map((item) => summarizeValue(item, depth + 1));
      if (value.length > 3) shown.push(`+${value.length - 3}`);
      return `[${shown.join(", ")}]`;
    }
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    const parts = keys.slice(0, 10).map((key) => {
      if (redactKey(key)) return `${key}=<redacted>`;
      return `${key}=${summarizeValue(value[key], depth + 1)}`;
    });
    if (keys.length > 10) parts.push(`+${keys.length - 10}`);
    return `{${parts.join(", ")}}`;
  }

  function summarizeBody(value) {
    const text = value == null || value === "" ? "empty body" : summarizeValue(value, 0);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }

  function findErrorCode(value, depth) {
    if (!value || typeof value !== "object" || depth > 5) return "";
    if (typeof value.error_code === "string" || typeof value.error_code === "number") {
      const code = String(value.error_code);
      if (code && code !== "null") return code;
    }
    const nested = Array.isArray(value) ? value : Object.values(value);
    for (let i = 0; i < nested.length && i < 20; i += 1) {
      const found = findErrorCode(nested[i], depth + 1);
      if (found) return found;
    }
    return "";
  }

  function deleteFieldReport(json) {
    const data = json && json.data;
    const field = data && typeof data === "object" ? data.xchat_delete_conversation : undefined;
    const watched = ["__typename", "conversation_id", "is_deleted_by_viewer", "error_code", "deleted", "success"];
    const parts = watched.map((key) => {
      if (!field || typeof field !== "object" || !Object.prototype.hasOwnProperty.call(field, key)) return `${key}=absent`;
      if (field[key] == null) return `${key}=null`;
      if (typeof field[key] === "string" || typeof field[key] === "number" || typeof field[key] === "boolean") {
        return `${key}=${String(field[key]).slice(0, 80)}`;
      }
      return `${key}=${typeof field[key]}`;
    });
    const extra = field && typeof field === "object"
      ? Object.keys(field).filter((key) => watched.indexOf(key) === -1 && !redactKey(key)).slice(0, 8)
      : [];
    const top = json && typeof json === "object" ? Object.keys(json).filter((key) => !redactKey(key)).slice(0, 8).join(",") : "";
    return `fields ${parts.join(" ")}${extra.length ? ` extra=${extra.join(",")}` : ""} top=${top || "none"}`;
  }

  function confirmsDelete(value, depth) {
    if (!value || typeof value !== "object" || depth > 4) return false;
    if (Array.isArray(value)) return value.some((item) => confirmsDelete(item, depth + 1));
    if (value.is_deleted_by_viewer === true || value.deleted === true || value.success === true) return true;
    return Object.values(value).some((item) => item && typeof item === "object" && confirmsDelete(item, depth + 1));
  }

  function xchatDeleteVerdict(json) {
    const top = responseError(json);
    if (top) return { ok: false, error: top };
    const code = findErrorCode(json);
    if (code && !/^(0|ok|success|none)$/i.test(code)) return { ok: false, error: `error_code ${code}` };
    if (!json || typeof json !== "object" || !json.data || typeof json.data !== "object") {
      return { ok: false, error: "response had no delete confirmation" };
    }
    const fields = Object.values(json.data).filter((item) => item != null);
    if (!fields.length) return { ok: false, error: "mutation data was empty" };
    if (!fields.some((field) => confirmsDelete(field, 0))) {
      return { ok: false, error: "response did not confirm the delete" };
    }
    return { ok: true, error: "" };
  }

  function legacyStillPresent(json, id) {
    if (!json || typeof json !== "object" || !id) return false;
    const seen = new Set();
    const stack = [{ value: json, depth: 0 }];
    let steps = 0;
    while (stack.length && steps < 400) {
      const current = stack.pop();
      steps += 1;
      const value = current.value;
      if (!value || typeof value !== "object" || seen.has(value) || current.depth > 6) continue;
      seen.add(value);
      if (value.conversation_id === id) return true;
      const nested = Array.isArray(value) ? value : Object.keys(value)
        .filter((key) => !redactKey(key))
        .map((key) => value[key]);
      for (let i = 0; i < nested.length && i < 40; i += 1) {
        if (nested[i] && typeof nested[i] === "object") stack.push({ value: nested[i], depth: current.depth + 1 });
      }
    }
    return false;
  }

  function needsDeviceSignature(message) {
    return /action signature|encoded_conversation_delete|device key|not authorized to delete/i.test(String(message || ""));
  }

  return {
    BUCKETS,
    BUCKET_NAME,
    TIMELINES,
    asTimeMs,
    readableName,
    bucketFor,
    parseLegacyPage,
    parseXchatPage,
    cursorMoved,
    createIndex,
    mergeParsed,
    selfIdFromCookie,
    inferSelfId,
    labelFor,
    whenLabel,
    presentConversation,
    matchesFilter,
    retryWaitMs,
    clampDelay,
    validConversationId,
    conversationIdForms,
    responseError,
    summarizeBody,
    xchatDeleteVerdict,
    deleteFieldReport,
    legacyStillPresent,
    needsDeviceSignature
  };
});
