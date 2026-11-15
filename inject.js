/* Page-world runner. Lists and deletes conversations on the signed-in account.
   Message bodies are never stored. Deletion matches X's "Delete conversation":
   the thread leaves this inbox, and the other person keeps their copy. */
(function () {
  if (globalThis.__xnukedmsInstalled) return;
  globalThis.__xnukedmsInstalled = true;
  if (!globalThis.XNukeInbox) return;

  const SOURCE = "xnukedms";
  const OPS_KEY = "xnukedms-ops";
  const MAX_PAGES = 200;
  const BEARER_FALLBACK =
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const SEEDS = {
    GetInitialXChatPageQuery: "m1gzpOV8JFOTaFH0Xq7lMQ",
    GetInboxPageRequestQuery: "sn-eWy4P0iEWEXUVuxTheg",
    ConversationDeleteMutation: "YHFgPwrwwnml8gF8H1YhCA"
  };
  const DELETE_BODY = [
    "dm_secret_conversations_enabled=false",
    "krs_registration_enabled=true",
    "cards_platform=Web-12",
    "include_cards=1",
    "include_ext_alt_text=true",
    "include_ext_limited_action_results=true",
    "include_quote_count=true",
    "include_reply_count=1",
    "tweet_mode=extended",
    "include_ext_views=true",
    "dm_users=false",
    "include_groups=true",
    "include_inbox_timelines=true",
    "include_ext_media_color=true",
    "supports_reactions=true",
    "supports_edit=true",
    "include_conversation_info=true"
  ].join("&");

  const originalFetch = window.fetch.bind(window);
  let capturedBearer = "";
  let transactionId = "";
  let runToken = 0;
  let discovering = null;
  const JOB_KEY = "xnukedms-delete-job";
  const LOG_KEY = "xnukedms-log";
  let signedDeletes = 0;
  let cachedDeleter = undefined;
  let pageDeleteRunning = false;
  let inboxCensus = null;
  const ops = {
    deleteQuery: "",
    deleteId: "",
    deleteName: "",
    inboxQuery: "",
    inboxId: "",
    initialQuery: "",
    initialId: ""
  };
  const state = XNukeInbox.createIndex();
  state.phase = "idle";
  state.deleted = 0;
  state.failed = 0;
  state.total = 0;
  state.message = "Scan the inbox when you are ready.";
  state.warnings = [];
  state.log = [];
  state.selfId = "";

  function post(payload) {
    window.postMessage({ source: SOURCE, to: "content", ...payload }, "*");
  }

  function logLine(level, text) {
    const stamp = new Date().toLocaleTimeString();
    state.log.push({ level, text: `${stamp} ${text}` });
    if (state.log.length > 120) state.log.splice(0, state.log.length - 120);
    try {
      sessionStorage.setItem(LOG_KEY, JSON.stringify(state.log));
    } catch (error) {
      /* session storage can be blocked */
    }
  }

  function warn(text) {
    state.warnings.push(text);
    logLine("fail", text);
  }

  function requestPath(url) {
    try {
      return new URL(url, location.origin).pathname;
    } catch (error) {
      return String(url || "").split("?")[0];
    }
  }

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function publish(includeList) {
    const now = Date.now();
    const selfId = state.selfId || XNukeInbox.inferSelfId([...state.conversations.values()]);
    const payload = {
      type: "status",
      phase: state.phase,
      deleted: state.deleted,
      failed: state.failed,
      total: state.total,
      found: state.conversations.size,
      message: state.message,
      warnings: state.warnings.slice(0, 4),
      log: state.log.slice(-80)
    };
    if (includeList) {
      payload.conversations = [...state.conversations.values()]
        .map((conv) => XNukeInbox.presentConversation(conv, state.users, selfId, now))
        .sort((a, b) => (b.sortAt || 0) - (a.sortAt || 0) || a.label.localeCompare(b.label));
    }
    post(payload);
  }

  function sleep(ms, alive) {
    return new Promise((resolve) => {
      const step = 200;
      let left = ms;
      const tick = () => {
        if (alive && !alive()) {
          resolve(false);
          return;
        }
        if (left <= 0) {
          resolve(!alive || alive());
          return;
        }
        const wait = Math.min(step, left);
        left -= wait;
        window.setTimeout(tick, wait);
      };
      tick();
    });
  }

  function inboxParams(extra) {
    const params = new URLSearchParams({
      nsfw_filtering_enabled: "false",
      filter_low_quality: "false",
      include_profile_interstitial_type: "1",
      include_blocking: "1",
      include_blocked_by: "1",
      include_followed_by: "1",
      include_want_retweets: "1",
      include_mute_edge: "1",
      include_can_dm: "1",
      include_can_media_tag: "1",
      include_ext_is_blue_verified: "1",
      include_ext_verified_type: "1",
      include_ext_profile_image_shape: "1",
      skip_status: "1",
      dm_secret_conversations_enabled: "false",
      krs_registration_enabled: "true",
      cards_platform: "Web-12",
      include_cards: "1",
      include_ext_alt_text: "true",
      include_ext_limited_action_results: "true",
      include_quote_count: "true",
      include_reply_count: "1",
      tweet_mode: "extended",
      include_ext_views: "true",
      dm_users: "true",
      include_groups: "true",
      include_inbox_timelines: "true",
      include_ext_media_color: "true",
      supports_reactions: "true",
      supports_edit: "true",
      include_conversation_info: "true"
    });
    if (extra) {
      for (const key of Object.keys(extra)) {
        if (extra[key]) params.set(key, extra[key]);
      }
    }
    return params;
  }

  function inboxUrl(kind, timeline, maxId) {
    const extra = {};
    if (maxId) extra.max_id = maxId;
    if (timeline && timeline.quality) extra.include_quality = timeline.quality;
    const path = kind === "initial"
      ? "/i/api/1.1/dm/inbox_initial_state.json"
      : `/i/api/1.1/dm/inbox_timeline/${timeline.path}.json`;
    return `${location.origin}${path}?${inboxParams(extra)}`;
  }

  async function request(url, init) {
    const headers = new Headers(init && init.headers);
    headers.set("authorization", capturedBearer || BEARER_FALLBACK);
    const csrf = csrfToken();
    if (csrf) headers.set("x-csrf-token", csrf);
    headers.set("x-twitter-active-user", "yes");
    headers.set("x-twitter-auth-type", "OAuth2Session");
    if (transactionId) headers.set("x-client-transaction-id", transactionId);
    let response;
    try {
      response = await originalFetch(url, {
        method: (init && init.method) || "GET",
        headers,
        body: init && init.body,
        credentials: "include",
        mode: "cors"
      });
    } catch (error) {
      return { ok: false, status: 0, json: null, path: requestPath(url), summary: "network error", error: "Network error", waitMs: 0, blocked: false };
    }
    const waitMs = XNukeInbox.retryWaitMs(
      response.status,
      response.headers.get("x-rate-limit-reset"),
      Date.now()
    );
    let json = null;
    let raw = "";
    try {
      raw = await response.text();
      if (raw) json = JSON.parse(raw);
    } catch (error) {
      json = null;
    }
    const error = XNukeInbox.responseError(json);
    const ok = response.ok && !error;
    const summary = json
      ? XNukeInbox.summarizeBody(json)
      : XNukeInbox.summarizeBody(raw ? raw.slice(0, 500) : "");
    return {
      ok,
      status: response.status,
      json,
      path: requestPath(url),
      summary,
      error: error || (response.ok ? "" : `HTTP ${response.status}`),
      waitMs,
      blocked: false
    };
  }

  function loadOps() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(OPS_KEY) || "{}");
      if (!saved || typeof saved !== "object") return;
      for (const key of Object.keys(ops)) {
        if (typeof saved[key] === "string" && saved[key]) ops[key] = saved[key];
      }
    } catch (error) {
      /* session storage can be blocked */
    }
  }

  function saveOps() {
    try {
      sessionStorage.setItem(OPS_KEY, JSON.stringify(ops));
    } catch (error) {
      /* ignore quota and privacy blocks */
    }
  }

  function sliceOperation(source, name) {
    const tokens = [`query ${name}`, `mutation ${name}`];
    for (const token of tokens) {
      const at = source.indexOf(token);
      if (at < 1) continue;
      const quote = source[at - 1];
      if (quote !== '"' && quote !== "'" && quote !== "`") continue;
      let i = at;
      let out = "";
      while (i < source.length && out.length < 120000) {
        const ch = source[i];
        if (ch === "\\") {
          const next = source[i + 1] || "";
          if (next === "n") out += "\n";
          else if (next === "t") out += "\t";
          else out += next;
          i += 2;
          continue;
        }
        if (ch === quote) return out;
        out += ch;
        i += 1;
      }
    }
    return "";
  }

  function operationId(source, name) {
    const patterns = [
      new RegExp(`queryId:"([A-Za-z0-9_-]+)"[\\s\\S]{0,160}?operationName:"${name}"`),
      new RegExp(`operationName:"${name}"[\\s\\S]{0,160}?queryId:"([A-Za-z0-9_-]+)"`)
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match) return match[1];
    }
    return "";
  }

  function rememberOperation(name, query, id) {
    if (name === "ConversationDeleteMutation" || (/delete/i.test(name) && /conversation|xchat/i.test(name))) {
      if (query) ops.deleteQuery = query;
      if (id) ops.deleteId = id;
      if (name) ops.deleteName = name;
    } else if (name === "GetInboxPageRequestQuery") {
      if (query) ops.inboxQuery = query;
      if (id) ops.inboxId = id;
    } else if (name === "GetInitialXChatPageQuery") {
      if (query) ops.initialQuery = query;
      if (id) ops.initialId = id;
    }
  }

  function rememberFromText(text) {
    const names = ["ConversationDeleteMutation", "GetInboxPageRequestQuery", "GetInitialXChatPageQuery"];
    for (const name of names) rememberOperation(name, sliceOperation(text, name), operationId(text, name));
  }

  function variableKeys(value, prefix, out, depth) {
    if (!value || typeof value !== "object" || depth > 3 || out.length > 30) return;
    const keys = Object.keys(value).slice(0, 20);
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (/signature|encoded|token|ciphertext|secret|authorization|cookie/i.test(key)) {
        out.push(`${path}=<redacted>`);
        continue;
      }
      const child = value[key];
      if (child && typeof child === "object") variableKeys(child, path, out, depth + 1);
      else {
        const shown = child == null ? "null" : String(child);
        out.push(shown.length > 80 ? path : `${path}=${shown}`);
      }
    }
  }

  function unwrapVariables(value) {
    let current = value;
    for (let i = 0; i < 2 && typeof current === "string"; i += 1) {
      try {
        current = JSON.parse(current);
      } catch (error) {
        return current;
      }
    }
    return current;
  }

  function rememberRequest(url, body) {
    const href = String(url || "");
    const idMatch = href.match(/\/graphql\/([^/?#]+)\/([A-Za-z0-9_]+)/);
    const urlName = idMatch ? idMatch[2] : "";
    if (idMatch && /delete/i.test(urlName)) {
      ops.deleteId = idMatch[1];
      ops.deleteName = urlName;
    } else if (idMatch) {
      rememberOperation(urlName, "", idMatch[1]);
    }
    if (typeof body !== "string" || !body || body.length > 500000) {
      if (idMatch && /delete/i.test(urlName)) saveOps();
      return;
    }
    const known = /delete/i.test(urlName)
      || /ConversationDeleteMutation|GetInboxPageRequestQuery|GetInitialXChatPageQuery|delete/i.test(body);
    if (!known) return;
    let json;
    try {
      json = JSON.parse(body);
    } catch (error) {
      return;
    }
    if (!json || typeof json !== "object") return;
    const name = typeof json.operationName === "string" && json.operationName ? json.operationName : urlName;
    if (!name) return;
    const sameOp = idMatch && idMatch[2] === name;
    rememberOperation(name, typeof json.query === "string" ? json.query : "", sameOp ? idMatch[1] : "");
    if (/delete/i.test(name)) {
      const variables = unwrapVariables(json.variables);
      const keys = [];
      variableKeys(variables && typeof variables === "object" ? variables : {}, "", keys, 0);
      const signed = !!(variables && typeof variables === "object" && Array.isArray(variables.action_signatures) && variables.action_signatures.length);
      if (signed || keys.some((key) => key.indexOf("<redacted>") !== -1)) signedDeletes += 1;
      if (pageDeleteRunning) {
        if (signed) logLine("info", "signed delete sent");
      } else {
        logLine("info", `captured ${name} vars ${keys.join(",") || "none"}`);
      }
    }
    saveOps();
  }

  function scriptUrls() {
    const urls = new Set();
    for (const script of document.scripts) {
      if (script.src) urls.add(script.src);
    }
    if (performance && typeof performance.getEntriesByType === "function") {
      for (const entry of performance.getEntriesByType("resource")) {
        if (/\.js(\?|$)/.test(entry.name)) urls.add(entry.name);
      }
    }
    return [...urls].slice(0, 40);
  }

  function discoverOps() {
    loadOps();
    if (ops.deleteQuery && ops.inboxQuery) return Promise.resolve();
    if (discovering) return discovering;
    discovering = (async () => {
      const urls = scriptUrls();
      for (let i = 0; i < urls.length; i += 4) {
        if (ops.deleteQuery && ops.inboxQuery) break;
        await Promise.all(urls.slice(i, i + 4).map(async (url) => {
          try {
            const response = await originalFetch(url);
            if (!response.ok) return;
            rememberFromText(await response.text());
          } catch (error) {
            /* a blocked script should not stop the scan */
          }
        }));
      }
      saveOps();
      discovering = null;
    })();
    return discovering;
  }

  function headerValue(headers, name) {
    if (!headers) return "";
    try {
      return new Headers(headers).get(name) || "";
    } catch (error) {
      return "";
    }
  }

  function requestBodyText(body) {
    if (typeof body === "string") return body;
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
    return "";
  }

  function captureRequest(input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      const body = requestBodyText(init && init.body);
      rememberRequest(url, body);
      if (!body && typeof Request !== "undefined" && input instanceof Request) {
        input.clone().text().then((text) => rememberRequest(input.url, text)).catch(() => {});
      }
      const bearer = headerValue(init && init.headers, "authorization");
      if (bearer.startsWith("Bearer ")) capturedBearer = bearer;
      const transaction = headerValue(init && init.headers, "x-client-transaction-id");
      if (transaction) transactionId = transaction;
      if (typeof Request !== "undefined" && input instanceof Request) {
        const fromRequest = input.headers.get("authorization") || "";
        if (fromRequest.startsWith("Bearer ")) capturedBearer = fromRequest;
        const fromTransaction = input.headers.get("x-client-transaction-id") || "";
        if (fromTransaction) transactionId = fromTransaction;
      }
    } catch (error) {
      /* header inspection is best-effort */
    }
  }

  function observeResponse(response, input) {
    try {
      const url = (response && response.url) || (typeof input === "string" ? input : input && input.url) || "";
      if (!/inbox_initial_state|inbox_timeline|GetInitialXChatPageQuery|GetInboxPageRequestQuery/i.test(url)) return;
      response.clone().json().then((json) => {
        if (state.phase === "scan" || state.phase === "delete") return;
        const parsed = /GetInitialXChatPageQuery|GetInboxPageRequestQuery/i.test(url)
          ? XNukeInbox.parseXchatPage(json, viewerId())
          : XNukeInbox.parseLegacyPage(json);
        if (!parsed) return;
        const added = XNukeInbox.mergeParsed(state, parsed);
        if (!added) return;
        state.selfId = state.selfId || XNukeInbox.selfIdFromCookie(document.cookie);
        state.phase = "done";
        state.message = `${state.conversations.size} conversations seen on this page. Scan to pull the rest of the inbox.`;
        publish(true);
      }).catch(() => {});
    } catch (error) {
      /* a non-cloneable body should not affect the page */
    }
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xnukeUrl = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      rememberRequest(this.__xnukeUrl, requestBodyText(body));
    } catch (error) {
      /* observing a request must not break the page */
    }
    return originalSend.apply(this, arguments);
  };

  window.fetch = function (input, init) {
    captureRequest(input, init);
    const pending = originalFetch(input, init);
    if (pending && typeof pending.then === "function") {
      return pending.then((response) => {
        observeResponse(response, input);
        return response;
      });
    }
    return pending;
  };

  function xchatNote(parsed) {
    const count = `${parsed.conversations.length}${parsed.itemCount ? ` of ${parsed.itemCount}` : ""}`;
    const skip = parsed.skippedOutline ? ` ${parsed.skippedOutline}` : "";
    const shape = !parsed.itemCount && parsed.pageKeys ? ` page ${parsed.pageKeys}` : "";
    const self = viewerId();
    return `parsed ${count} self=${self || "none"}${skip}${shape}`;
  }

  function viewerId() {
    return state.selfId || XNukeInbox.selfIdFromCookie(document.cookie);
  }

  function continueCursorValue(cursor, style) {
    if (style === "cursor-string") return cursor.cursorId;
    const value = { cursor_id: cursor.cursorId };
    if (cursor.snapshotId) value.graph_snapshot_id = cursor.snapshotId;
    return value;
  }

  function pageVariables(cursor, style) {
    return {
      continue_cursor: continueCursorValue(cursor, style),
      include_user_public_keys: false,
      include_juicebox_tokens: false,
      include_all_group_member_user_objects: false,
      include_participants_results_for_inbox_preview: true
    };
  }

  function operationVariables(query, hints) {
    const names = new Set();
    const re = /\$([A-Za-z0-9_]+)/g;
    let match = re.exec(query || "");
    while (match) {
      names.add(match[1]);
      match = re.exec(query);
    }
    const variables = {};
    for (const name of names) {
      if (/conversation/i.test(name) && hints.conversationId) variables[name] = hints.conversationId;
      else if (name === "continue_cursor" && hints.cursorId) variables[name] = continueCursorValue(hints, "cursor-object");
      else if (/cursor/i.test(name) && hints.cursorId) variables[name] = hints.cursorId;
      else if (/snapshot/i.test(name) && hints.snapshotId) variables[name] = hints.snapshotId;
    }
    if (hints.conversationId && !Object.keys(variables).some((name) => /conversation/i.test(name))) {
      variables.conversation_id = hints.conversationId;
    }
    return variables;
  }

  function graphql(name, queryId, query, variables) {
    return request(`${location.origin}/i/api/graphql/${queryId}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationName: name, variables, query, queryId })
    });
  }

async function scanLegacy(alive) {
  let first = await request(inboxUrl("initial"), { method: "GET" });
  if (!alive()) return false;
  if (first.status === 429 || first.status === 420) {
    state.message = `Rate limited. Waiting ${Math.ceil((first.waitMs || 60000) / 1000)}s…`;
    publish(false);
    if (!(await sleep(first.waitMs || 60000, alive))) return false;
    first = await request(inboxUrl("initial"), { method: "GET" });
    if (!alive()) return false;
  }
  if (first.status === 401 || first.status === 403) {
      warn("X refused the legacy inbox. Reload x.com while signed in.");
      return false;
    }
    const parsed = first.json ? XNukeInbox.parseLegacyPage(first.json) : null;
    if (!parsed) {
      warn(first.error || "Legacy inbox response was empty.");
      return false;
    }
    XNukeInbox.mergeParsed(state, parsed);
    state.message = `Scanning… ${state.conversations.size} so far`;
    publish(false);
    const cursors = parsed.initialCursors || {};
    for (const timeline of XNukeInbox.TIMELINES) {
      let cursor = cursors[timeline.id];
      let pages = 0;
      while (alive() && cursor && cursor.status === "HAS_MORE" && cursor.minEntryId && pages < MAX_PAGES) {
        if (!(await sleep(350, alive))) return false;
        pages += 1;
        state.message = `Scanning ${timeline.id.replace(/_/g, " ")}… ${state.conversations.size} so far`;
        publish(false);
        const page = await request(inboxUrl("timeline", timeline, cursor.minEntryId), { method: "GET" });
        if (!alive()) return false;
        if (page.status === 429 || page.status === 420) {
          state.message = `Rate limited. Waiting ${Math.ceil((page.waitMs || 60000) / 1000)}s…`;
          publish(false);
          if (!(await sleep(page.waitMs || 60000, alive))) return false;
          pages -= 1;
          continue;
        }
        const nextParsed = page.json ? XNukeInbox.parseLegacyPage(page.json) : null;
        if (!nextParsed) {
          warn(`Stopped paging ${timeline.id}: ${page.error || "empty page"}`);
          break;
        }
        XNukeInbox.mergeParsed(state, nextParsed);
        const next = nextParsed.pageCursor;
        if (!XNukeInbox.cursorMoved(cursor.minEntryId, next)) break;
        cursor = { status: next.status || "HAS_MORE", minEntryId: next.minEntryId };
      }
      if (pages >= MAX_PAGES) warn(`Stopped after ${MAX_PAGES} pages of ${timeline.id}.`);
    }
    return true;
  }

  async function scanXchat(alive) {
    const xchat = globalThis.XNukeXchat;
    if (!xchat && !ops.initialQuery) return;
    const first = await graphql(
      "GetInitialXChatPageQuery",
      ops.initialId || (xchat && xchat.INITIAL_ID) || SEEDS.GetInitialXChatPageQuery,
      ops.initialQuery || (xchat && xchat.INITIAL_QUERY) || "",
      {
        include_user_public_keys: false,
        include_juicebox_tokens: false,
        include_all_group_member_user_objects: false,
        include_participants_results_for_inbox_preview: true
      }
    );
    if (!alive()) return;
    const error = XNukeInbox.responseError(first.json);
    const parsed = first.json ? XNukeInbox.parseXchatPage(first.json, viewerId()) : null;
    if (!parsed) {
      const detail = error || first.error || `HTTP ${first.status}`;
      warn(`X Chat inbox: ${detail}. ${first.summary || ""}`.trim());
      return;
    }
    XNukeInbox.mergeParsed(state, parsed);
    logLine(parsed.conversations.length && !error ? "ok" : "fail", `xchat scan HTTP ${first.status} ${xchatNote(parsed)}${error ? ` ${error}` : ""}`.trim());
    if (error) state.warnings.push(`X Chat inbox: ${error}`);
    let cursor = parsed.cursor;
    let pages = 0;
    let styleIndex = 0;
    const styles = ["cursor-object", "cursor-string"];
    while (alive() && cursor && !cursor.done && cursor.cursorId && pages < MAX_PAGES) {
      pages += 1;
      const style = styles[Math.min(styleIndex, styles.length - 1)];
      const query = ops.inboxQuery || (xchat && xchat.inboxPageQuery && xchat.inboxPageQuery()) || "";
      if (!query) break;
      state.message = `Scanning X Chat… ${state.conversations.size} so far`;
      publish(false);
      if (!(await sleep(350, alive))) return;
      const page = await graphql(
        "GetInboxPageRequestQuery",
        ops.inboxId || SEEDS.GetInboxPageRequestQuery,
        query,
        ops.inboxQuery
          ? operationVariables(ops.inboxQuery, cursor)
          : pageVariables(cursor, style)
      );
      if (!alive()) return;
      if (page.status === 429 || page.status === 420) {
        if (!(await sleep(page.waitMs || 60000, alive))) return;
        pages -= 1;
        continue;
      }
      const nextError = XNukeInbox.responseError(page.json);
      const next = page.json ? XNukeInbox.parseXchatPage(page.json, viewerId()) : null;
      if (next && page.status < 400 && !nextError) {
        const added = XNukeInbox.mergeParsed(state, next);
        const note = `xchat page ${style} ${xchatNote(next)} added ${added}`;
        logLine(next.conversations.length ? "ok" : "fail", note);
        if (!next.cursor || next.cursor.done || !next.cursor.cursorId || next.cursor.cursorId === cursor.cursorId) break;
        cursor = next.cursor;
        continue;
      }
      if (!ops.inboxQuery && styleIndex < styles.length - 1) {
        logLine("fail", `xchat page ${style} HTTP ${page.status} ${nextError || page.error || "no conversations"} ${page.summary || ""}`.replace(/\s+/g, " ").trim());
        styleIndex += 1;
        pages -= 1;
        continue;
      }
      warn(`X Chat paging stopped: ${nextError || page.error || "no conversations"}. ${page.summary || ""}`.trim());
      break;
    }
  }

  async function scan() {
    const token = ++runToken;
    const alive = () => token === runToken;
    state.phase = "scan";
    state.deleted = 0;
    state.failed = 0;
    state.total = 0;
    state.warnings = [];
    state.conversations.clear();
    state.users = {};
    state.selfId = XNukeInbox.selfIdFromCookie(document.cookie);
    state.message = "Scanning inbox…";
    publish(true);
    if (!csrfToken()) {
      state.phase = "error";
      state.message = "Sign in to X, then reload this tab.";
      publish(true);
      return;
    }
    const discovery = discoverOps();
    await scanLegacy(alive);
    if (!alive()) {
      state.phase = "idle";
      state.message = `Stopped. ${state.conversations.size} conversations found.`;
      publish(true);
      return;
    }
    await discovery;
    if (!alive()) return;
    await scanXchat(alive);
    if (!alive()) {
      state.phase = "idle";
      state.message = `Stopped. ${state.conversations.size} conversations found.`;
      publish(true);
      return;
    }
    const count = state.conversations.size;
    state.phase = count || !state.warnings.length ? "done" : "error";
    state.message = count
      ? `Found ${count} conversation${count === 1 ? "" : "s"}.`
      : "No conversations found.";
    logLine(count ? "ok" : "fail", `scan finished with ${count} conversations`);
    publish(true);
  }

  function noteResult(kind, id, result, verdict) {
    const reason = verdict || result.reason || result.error || (result.ok ? "accepted" : `HTTP ${result.status}`);
    logLine(result.ok ? "ok" : "fail", `${kind} ${id} ${result.path || ""} HTTP ${result.status} ${reason} ${result.summary || ""}`.replace(/\s+/g, " ").trim());
    return reason;
  }

  async function verifyLegacy(id, deleted) {
    const check = await request(
      `${location.origin}/i/api/1.1/dm/conversation/${encodeURIComponent(id)}.json?${inboxParams({ context: "FETCH_DM_CONVERSATION" })}`,
      { method: "GET" }
    );
    if (check.status === 404 || (check.ok && !XNukeInbox.legacyStillPresent(check.json, id))) {
      noteResult("legacy verify", id, { ...check, ok: true }, "conversation is gone from the legacy inbox");
      return { ...deleted, ok: true, error: "", reason: "" };
    }
    if (XNukeInbox.legacyStillPresent(check.json, id)) {
      const reason = "delete was accepted but the conversation is still in the legacy inbox";
      noteResult("legacy verify", id, { ...check, ok: false, reason }, reason);
      return { ok: false, status: deleted.status, error: reason, reason, summary: check.summary, blocked: false };
    }
    const reason = `delete returned HTTP ${deleted.status}; verify failed`;
    noteResult("legacy verify", id, { ...check, ok: false, reason }, `${reason}: ${check.error || "HTTP " + check.status}`);
    return { ok: false, status: check.status, error: `${reason}: ${check.error || "HTTP " + check.status}`, reason, summary: check.summary, blocked: false };
  }

  async function deleteLegacy(id) {
    const init = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: DELETE_BODY
    };
    let deleted = await request(
      `${location.origin}/i/api/1.1/dm/conversation/${encodeURIComponent(id)}/delete.json`,
      init
    );
    noteResult("legacy delete", id, deleted);
    if (deleted.status === 404) {
      deleted = await request(`${location.origin}/i/api/1.1/dm/${encodeURIComponent(id)}/delete.json`, init);
      noteResult("legacy delete", id, deleted);
    }
    if (!deleted.ok) return deleted;
    return verifyLegacy(id, deleted);
  }

  function deleteVariables(query, id) {
    const variables = operationVariables(query, { conversationId: id });
    if (!Object.keys(variables).some((name) => /conversation/i.test(name))) variables.conversation_id = id;
    return variables;
  }

  function missingVariable(json) {
    const errors = json && json.errors;
    if (!Array.isArray(errors)) return "";
    for (const error of errors) {
      const path = error && error.path;
      if (Array.isArray(path) && path[0] === "variable" && typeof path[1] === "string") return path[1];
    }
    return "";
  }

  async function deleteXchat(id) {
    const xchat = globalThis.XNukeXchat;
    const query = ops.deleteQuery || (xchat && xchat.DELETE_QUERY) || "";
    const queryId = ops.deleteId || (xchat && xchat.DELETE_ID) || SEEDS.ConversationDeleteMutation;
    const name = ops.deleteName || "ConversationDeleteMutation";
    if (!query) {
      const reason = "X Chat delete query was not found.";
      logLine("fail", `xchat ${id} ${reason}`);
      return { ok: false, status: 0, error: reason, reason, blocked: true, summary: "" };
    }
    const usingCaptured = !!ops.deleteQuery;
    let variables = deleteVariables(query, id);
    let result = await graphql(name, queryId, query, variables);
    const missing = missingVariable(result.json);
    if (missing && /conversation/i.test(missing) && variables[missing] !== id) {
      variables = { ...variables, [missing]: id };
      result = await graphql(name, queryId, query, variables);
    }
    const sent = [];
    variableKeys(variables, "", sent, 0);
    logLine("info", `xchat delete request ${name} ${queryId} source=${usingCaptured ? "captured" : "bundled"} vars ${sent.join(",") || "none"}`);
    logLine("info", `xchat delete response ${XNukeInbox.deleteFieldReport(result.json)}`);
    const verdict = XNukeInbox.xchatDeleteVerdict(result.json);
    const serverError = result.error || "";
    const missingName = missingVariable(result.json);
    const signatureRequired = XNukeInbox.needsDeviceSignature(serverError) || /signature|encoded/i.test(missingName);
    if (result.ok && !verdict.ok) {
      result.ok = false;
      result.blocked = true;
      result.reason = "X returned DeleteConversationResponse and did not remove the conversation.";
      result.error = result.reason;
    } else if (!result.ok) {
      result.reason = serverError || `HTTP ${result.status}`;
    }
    if (!result.ok && signatureRequired) {
      result.blocked = true;
      result.reason = "X refused the delete because it requires this browser's chat signature.";
      result.error = result.reason;
    }
    noteResult("xchat delete", id, result, result.ok ? "mutation confirmed" : result.reason);
    return result;
  }

  function sourceOf(fn) {
    try {
      return Function.prototype.toString.call(fn);
    } catch (error) {
      return "";
    }
  }

  function snippet(text) {
    return String(text || "").replace(/\s+/g, " ").slice(0, 160);
  }

  function controlText(el) {
    return `${el.getAttribute("aria-label") || ""} ${el.innerText || ""}`.replace(/\s+/g, " ").trim();
  }

  function eachRootFrom(start, visit) {
    const pending = [start];
    let depth = 0;
    while (pending.length && depth < 400) {
      const root = pending.shift();
      depth += 1;
      if (!root || !root.querySelectorAll) continue;
      visit(root);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) pending.push(el.shadowRoot);
      }
    }
  }

  function eachRoot(visit) {
    eachRootFrom(document, visit);
  }

  function controlCount() {
    let count = 0;
    eachRoot((root) => {
      count += root.querySelectorAll("button, [role='button'], [role='menuitem']").length;
    });
    return count;
  }

  function findControl(root, pattern) {
    let match = null;
    const search = (scope) => {
      if (match || !scope || !scope.querySelectorAll) return;
      for (const el of scope.querySelectorAll("button, [role='button'], [role='menuitem'], a, [data-testid]")) {
        if (!el || el.disabled) continue;
        const text = `${controlText(el)} ${el.getAttribute("data-testid") || ""}`.replace(/\s+/g, " ").trim();
        if (!text || text.length > 80) continue;
        if (pattern.test(text)) {
          match = el;
          return;
        }
      }
      for (const el of scope.querySelectorAll("*")) {
        if (el.shadowRoot) search(el.shadowRoot);
      }
    };
    search(root || document);
    return match;
  }

  function buttonLabels() {
    const labels = [];
    eachRoot((root) => {
      for (const el of root.querySelectorAll("button, [role='menuitem'], [role='button']")) {
        const text = controlText(el);
        if (!text || text.length > 60 || labels.indexOf(text) !== -1) continue;
        labels.push(text);
        if (labels.length >= 24) return;
      }
    });
    return labels.join(" | ");
  }

  function frameSummary() {
    return [...document.querySelectorAll("iframe")].slice(0, 8).map((frame) => {
      const src = frame.getAttribute("src") || "";
      let same = false;
      try {
        same = !!frame.contentDocument;
      } catch (error) {
        same = false;
      }
      return `${src.slice(0, 90) || "no-src"} ${same ? "same" : "cross"}`;
    }).join(" || ");
  }

  function shadowSummary() {
    const hosts = [];
    eachRoot((root) => {
      if (root.host && hosts.length < 12) hosts.push(root.host.tagName.toLowerCase());
    });
    return hosts.join(",") || "none";
  }

  function describeMfGlobals() {
    const bits = [];
    let names = [];
    try {
      names = Object.getOwnPropertyNames(window);
    } catch (error) {
      return;
    }
    for (const key of names) {
      if (!/xchat|__mf_init__|mfe/i.test(key)) continue;
      const value = window[key];
      let keys = "";
      if (value && typeof value === "object") {
        try {
          keys = Object.keys(value).slice(0, 10).join(",");
        } catch (error) {
          keys = "";
        }
      }
      const src = typeof value === "function" ? ` ${snippet(sourceOf(value))}` : "";
      bits.push(`${key.slice(0, 70)}:${typeof value}${keys ? `{${keys}}` : ""}${src}`);
      if (bits.length >= 6) break;
    }
    logLine("info", `mf ${bits.join(" | ") || "none"}`);
  }

  async function waitForChatUi() {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const labels = buttonLabels();
      const chatFrame = [...document.querySelectorAll("iframe")].some((frame) => {
        return /chat\.x\.com|\/i\/chat|\/messages/i.test(frame.getAttribute("src") || "");
      });
      if (/delete conversation|chat info|conversation information|message request|new message/i.test(labels)
        || chatFrame
        || shadowSummary() !== "none"
        || controlCount() >= 8) {
        return;
      }
      await sleep(400, () => true);
    }
  }

  function findConversationLink(id, scope) {
    const needles = [id, id.replace(/:/g, "-")];
    let match = null;
    eachRootFrom(scope || document, (root) => {
      if (match) return;
      for (const el of root.querySelectorAll("a[href]")) {
        const href = el.getAttribute("href") || "";
        if (needles.some((needle) => href.indexOf(needle) !== -1)) {
          match = el;
          return;
        }
      }
    });
    return match;
  }

  function findDialog(scope) {
    let dialog = null;
    eachRootFrom(scope || document, (root) => {
      if (!dialog) dialog = root.querySelector("[role='dialog'], [role='alertdialog']");
    });
    return dialog;
  }

  function rememberDeleteFn(fn, owner, label, found) {
    if (typeof fn !== "function" || found.some((item) => item.fn === fn)) return;
    const src = sourceOf(fn);
    if (!/ConversationDeleteMutation|xchat_delete_conversation/.test(src)) return;
    if (/SendMessage|encoded_message_create|add_public_key/i.test(src)) return;
    found.push({ fn, owner: owner || null, label });
  }

  function collectDeleteFns(value, prefix, found, depth) {
    if (!value || found.length > 8 || depth > 2) return;
    if (typeof value === "function") {
      rememberDeleteFn(value, null, prefix, found);
      return;
    }
    if (typeof value !== "object") return;
    let keys = [];
    try {
      keys = Object.getOwnPropertyNames(value);
    } catch (error) {
      return;
    }
    for (const key of keys.slice(0, 50)) {
      if (/^(prototype|caller|arguments|constructor)$/.test(key)) continue;
      let child;
      try {
        child = value[key];
      } catch (error) {
        continue;
      }
      if (typeof child === "function") rememberDeleteFn(child, value, `${prefix}.${key}`, found);
      else if (child && typeof child === "object") collectDeleteFns(child, `${prefix}.${key}`, found, depth + 1);
    }
  }

  function webpackRequires() {
    const found = [];
    let names = [];
    try {
      names = Object.getOwnPropertyNames(window);
    } catch (error) {
      return found;
    }
    for (const name of names) {
      if (name.indexOf("webpackChunk") === -1) continue;
      const chunk = window[name];
      if (!chunk || typeof chunk.push !== "function") continue;
      let req = null;
      try {
        chunk.push([[`xnukedms-${name}`], {}, (require) => { req = require; }]);
      } catch (error) {
        continue;
      }
      if (req && req.m) found.push({ name, req });
    }
    return found;
  }

  async function scanForDeleter() {
    const found = [];
    const reqs = webpackRequires();
    const globals = [];
    try {
      for (const key of Object.getOwnPropertyNames(window)) {
        if (/chat|xchat|\bdm\b|kotlin/i.test(key)) globals.push(key);
      }
    } catch (error) {
      /* some windows hide property names */
    }
    logLine("info", `page search chunks ${reqs.map((item) => item.name).join(",") || "none"} globals ${globals.slice(0, 20).join(",") || "none"}`);
    for (const key of globals) {
      try {
        collectDeleteFns(window[key], key, found, 0);
      } catch (error) {
        /* a sealed global is skipped */
      }
    }
    for (const item of reqs) {
      const ids = Object.keys(item.req.m);
      let hits = 0;
      for (let i = 0; i < ids.length && hits < 6; i += 1) {
        if (i % 300 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        let src = "";
        try {
          src = sourceOf(item.req.m[ids[i]]);
        } catch (error) {
          continue;
        }
        if (src.indexOf("ConversationDeleteMutation") === -1 && src.indexOf("xchat_delete_conversation") === -1) continue;
        hits += 1;
        logLine("info", `delete module ${ids[i]} len ${src.length} ${snippet(src)}`);
        let exported = item.req.c && item.req.c[ids[i]] && item.req.c[ids[i]].exports;
        if (!exported && src.length < 80000) {
          try {
            exported = item.req(ids[i]);
          } catch (error) {
            logLine("fail", `delete module ${ids[i]} did not load: ${snippet(error && error.message || error)}`);
          }
        }
        collectDeleteFns(exported, `module ${ids[i]}`, found, 0);
      }
    }
    found.sort((a, b) => sourceOf(a.fn).length - sourceOf(b.fn).length);
    return found[0] || null;
  }

  async function findCallableDelete() {
    if (cachedDeleter !== undefined) return cachedDeleter;
    cachedDeleter = await scanForDeleter();
    logLine("info", cachedDeleter ? `found ${cachedDeleter.label}` : "no page delete function in loaded scripts");
    return cachedDeleter;
  }

  async function waitForSigned(started, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (signedDeletes > started) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return signedDeletes > started;
  }

  function idForms(id) {
    return XNukeInbox.conversationIdForms(id);
  }

  function conversationItems() {
    const items = [];
    eachRoot((root) => {
      for (const el of root.querySelectorAll("[data-testid]")) {
        const testid = el.getAttribute("data-testid") || "";
        if (/^dm-(?:conversation|message-request)-item-/.test(testid)) items.push(el);
      }
    });
    return items;
  }

  function itemId(el) {
    return (el.getAttribute("data-testid") || "").replace(/^dm-(?:conversation|message-request)-item-/, "");
  }

  function findConversationItem(id) {
    const forms = idForms(id);
    return conversationItems().find((el) => forms.indexOf(itemId(el)) !== -1) || null;
  }

  function ancestorOf(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return root && root.host ? root.host : null;
  }

  function isPageScroller(el) {
    return !el || el === document.body || el === document.documentElement;
  }

  function inboxScrollers() {
    const found = [];
    const add = (el) => {
      if (!isPageScroller(el) && el.scrollHeight > el.clientHeight + 24 && found.indexOf(el) === -1) found.push(el);
    };
    eachRoot((root) => {
      for (const el of root.querySelectorAll("[data-testid='dm-conversation-scroller'], [data-testid='dm-message-requests-scroller'], [data-testid*='scroller']")) {
        add(el);
      }
    });
    for (const item of conversationItems().slice(0, 4)) {
      let node = item;
      let best = null;
      let bestRange = 24;
      while (node) {
        const range = node.scrollHeight - node.clientHeight;
        if (!isPageScroller(node) && range > bestRange) {
          best = node;
          bestRange = range;
        }
        node = ancestorOf(node);
      }
      add(best);
    }
    found.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return found.slice(0, 2);
  }

  function inboxPresent() {
    return conversationItems().length > 0 || inboxScrollers().length > 0;
  }

  async function waitForInbox() {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (inboxPresent()) return;
      await sleep(400, () => true);
    }
  }

  function isShown(el) {
    if (!el || !el.isConnected) return false;
    try {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
    } catch (error) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function openMenus() {
    const menus = [];
    eachRoot((root) => {
      for (const el of root.querySelectorAll("[role='menu']")) {
        if (el.getAttribute("data-state") === "closed" || el.hasAttribute("data-closed")) continue;
        if (isShown(el)) menus.push(el);
      }
    });
    return menus;
  }

  function openDialogs() {
    const dialogs = [];
    eachRoot((root) => {
      for (const el of root.querySelectorAll("[data-slot='xds-modal-surface'], [role='dialog'], [role='alertdialog']")) {
        if (el.getAttribute("data-state") === "closed" || el.hasAttribute("data-closed")) continue;
        if (isShown(el)) dialogs.push(el);
      }
    });
    return dialogs;
  }

  function menuEntries(menu) {
    return [...menu.querySelectorAll("[role='menuitem'], button")].filter((el) => {
      return el.getAttribute("aria-disabled") !== "true" && isShown(el) && controlText(el);
    });
  }

  function dispatchMouse(el, type, button) {
    const rect = el.getBoundingClientRect();
    const view = el.ownerDocument.defaultView || window;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view,
      clientX: rect.left + Math.min(32, Math.max(8, rect.width / 3)),
      clientY: rect.top + Math.min(24, Math.max(8, rect.height / 2)),
      button,
      buttons: button === 2 ? 2 : 1
    };
    if (type !== "contextmenu") {
      const pointer = type.replace("mouse", "pointer");
      el.dispatchEvent(new PointerEvent(pointer, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    }
    el.dispatchEvent(new MouseEvent(type, init));
  }

  function openRowMenu(el) {
    dispatchMouse(el, "mouseover", 0);
    dispatchMouse(el, "mousedown", 2);
    dispatchMouse(el, "contextmenu", 2);
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, composed: true, keyCode: 27 }));
  }

  async function waitForMenuEntry(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const menu of openMenus()) {
        const entry = menuEntries(menu).find((el) => /delete conversation|leave conversation/i.test(controlText(el)));
        if (entry) return entry;
      }
      await sleep(150, () => true);
    }
    return null;
  }

  async function openDeleteMenu(item) {
    const targets = [];
    const row = item.querySelector("[data-inbox-row]");
    const link = item.querySelector("a");
    if (row) targets.push(row);
    if (link) targets.push(link);
    targets.push(item);
    for (const target of targets) {
      openRowMenu(target);
      const action = await waitForMenuEntry(1600);
      if (action) return action;
      pressEscape();
      await sleep(150, () => true);
    }
    return null;
  }

  function confirmButton(dialog) {
    const buttons = [...dialog.querySelectorAll("button, [role='button']")].filter(isShown);
    const footer = buttons.filter((button) => button.closest("[data-slot='xds-modal-footer']"));
    const pool = footer.length ? footer : buttons;
    return pool.find((button) => /^(delete|confirm|delete conversation|leave|leave conversation)$/i.test(controlText(button)))
      || pool.filter((button) => controlText(button) && !/cancel/i.test(controlText(button))).pop()
      || null;
  }

  function activate(el) {
    dispatchMouse(el, "mousedown", 0);
    dispatchMouse(el, "mouseup", 0);
    el.click();
  }

  function rowIsListed(id, seen) {
    return idForms(id).some((form) => seen.has(form));
  }

  async function censusInbox() {
    if (inboxCensus) return inboxCensus;
    const seen = new Set();
    const note = () => {
      for (const row of conversationItems()) seen.add(itemId(row));
    };
    note();
    const scrollers = inboxScrollers();
    const scroller = scrollers[0];
    let moved = 0;
    if (scroller) {
      let idle = 0;
      for (let step = 0; step < 80 && idle < 5; step += 1) {
        const beforeCount = seen.size;
        const before = scroller.scrollTop;
        scroller.scrollTop = before + Math.max(80, Math.round(scroller.clientHeight * 0.35));
        await sleep(180, () => true);
        note();
        if (scroller.scrollTop - before > 2) moved += 1;
        idle = seen.size > beforeCount ? 0 : idle + 1;
        if (scroller.scrollTop - before < 2 && idle >= 5) break;
      }
    }
    let matched = 0;
    for (const id of state.conversations.keys()) {
      if (rowIsListed(id, seen)) matched += 1;
    }
    const lengths = {};
    for (const id of seen) lengths[id.length] = (lengths[id.length] || 0) + 1;
    const shape = Object.keys(lengths).map((length) => `${length}=${lengths[length]}`).join(",");
    inboxCensus = { seen, moved, scrollers: scrollers.length };
    logLine("info", `inbox listed ${seen.size} matched ${matched} scrollers ${scrollers.length} moved ${moved} lengths ${shape || "none"}`);
    return inboxCensus;
  }

  async function locateConversation(id) {
    const census = await censusInbox();
    if (!rowIsListed(id, census.seen)) return null;
    let el = findConversationItem(id);
    if (el) return el;
    const scroller = inboxScrollers()[0];
    if (!scroller) return null;
    scroller.scrollTop = 0;
    await sleep(150, () => true);
    for (let step = 0; step < 80; step += 1) {
      el = findConversationItem(id);
      if (el) return el;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + Math.max(80, Math.round(scroller.clientHeight * 0.35));
      await sleep(160, () => true);
      if (scroller.scrollTop - before < 2) break;
    }
    return findConversationItem(id);
  }

  async function confirmRowDelete(action, key, started) {
    const dialogsBefore = new Set(openDialogs());
    activate(action);
    let dialog = null;
    const dialogEnd = Date.now() + 3000;
    while (Date.now() < dialogEnd) {
      dialog = openDialogs().find((candidate) => !dialogsBefore.has(candidate)) || null;
      if (dialog) break;
      await sleep(150, () => true);
    }
    if (dialog) {
      const confirm = confirmButton(dialog);
      if (!confirm) {
        pressEscape();
        return { ok: false, reason: "Delete confirmation was not shown." };
      }
      activate(confirm);
    }
    let misses = 0;
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (signedDeletes > started) return { ok: true };
      const still = conversationItems().some((el) => itemId(el) === key);
      if (!still) {
        misses += 1;
        if (misses >= 2) return { ok: true };
      } else {
        misses = 0;
      }
      await sleep(250, () => true);
    }
    pressEscape();
    return { ok: false, reason: "X left the conversation in the list." };
  }

  async function deleteVisibleRow(row) {
    const started = signedDeletes;
    const key = itemId(row);
    row.scrollIntoView({ block: "nearest" });
    const opener = row.querySelector("a, [role='link']") || row;
    activate(opener);
    await sleep(800, () => true);
    const current = conversationItems().find((el) => itemId(el) === key) || row;
    let action = await openDeleteMenu(current);
    if (!action) action = findControl(document, /delete conversation|leave conversation/i);
    if (!action) {
      const more = findControl(document, /^(more|info|details)$/i) || findControl(document, /conversation information|chat info|more options/i);
      if (more) {
        activate(more);
        await sleep(500, () => true);
        action = findControl(document, /delete conversation|leave conversation/i);
      }
    }
    if (!action) {
      const labels = openMenus().flatMap((menu) => menuEntries(menu).map(controlText)).slice(0, 8).join(" | ");
      pressEscape();
      return { ok: false, reason: `Chat menu had no delete. menu ${labels || buttonLabels() || "none"}` };
    }
    return confirmRowDelete(action, key, started);
  }

  async function drainInbox(alive, delay) {
    const failed = new Set();
    let stuck = 0;
    while (alive()) {
      const row = conversationItems().find((el) => isShown(el) && !failed.has(itemId(el)));
      if (!row) {
        const scroller = inboxScrollers()[0];
        if (!scroller) break;
        const before = scroller.scrollTop;
        scroller.scrollTop = before + Math.max(80, Math.round(scroller.clientHeight * 0.4));
        await sleep(250, alive);
        const more = conversationItems().some((el) => isShown(el) && !failed.has(itemId(el)));
        if (!more || scroller.scrollTop - before < 2) {
          stuck += 1;
          if (stuck >= 3) break;
          scroller.scrollTop = 0;
          await sleep(250, alive);
        } else {
          stuck = 0;
        }
        continue;
      }
      stuck = 0;
      state.message = `Opening chat ${state.deleted + 1}…`;
      publish(false);
      const result = await deleteVisibleRow(row);
      if (result.ok) {
        state.deleted += 1;
        state.message = `Removed ${state.deleted}`;
        publish(true);
        if (!(await sleep(delay, alive))) break;
        continue;
      }
      failed.add(itemId(row));
      logLine("fail", result.reason || "row delete failed");
      if (failed.size >= 3 && !state.deleted) {
        state.phase = "error";
        state.message = result.reason || "Could not use the chat delete menu.";
        publish(true);
        return;
      }
      if (failed.size >= 5) break;
    }
    if (!alive()) return;
    clearJob();
    state.phase = state.deleted ? "done" : "error";
    state.message = state.deleted
      ? `Removed ${state.deleted} conversation${state.deleted === 1 ? "" : "s"}.`
      : "No conversations were removed. See the debug log.";
    publish(true);
  }
  async function clickDeleteUi(id, scope) {
    const root = scope || document;
    const link = findConversationLink(id, root);
    if (link) {
      link.click();
      await sleep(700, () => true);
    }
    let del = findControl(root, /delete conversation/i);
    if (!del) {
      const more = findControl(root, /^(more|info|details)$/i) || findControl(root, /conversation information|chat info|more options/i);
      if (more) {
        more.click();
        await sleep(500, () => true);
        del = findControl(root, /delete conversation/i);
      }
    }
    if (!del) return "missing";
    del.click();
    await sleep(500, () => true);
    const dialog = findDialog(root);
    const confirm = (dialog && findControl(dialog, /^delete$/i)) || findControl(root, /^delete$/i);
    if (!confirm) {
      logLine("fail", `delete confirmation was not shown. controls ${buttonLabels() || "none"}`);
      return "missing";
    }
    confirm.click();
    return "clicked";
  }

  async function clickDeleteInFrames(id) {
    for (const frame of chatFrames()) {
      let doc = null;
      try {
        doc = frame.contentDocument;
      } catch (error) {
        continue;
      }
      if (!doc) continue;
      const clicked = await clickDeleteUi(id, doc);
      if (clicked === "clicked") return "clicked";
    }
    return "missing";
  }

  function chatFrames() {
    return [...document.querySelectorAll("iframe")];
  }

  function deleteInFrames(id) {
    const frames = chatFrames();
    if (!frames.length) return Promise.resolve(null);
    const requestId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, 20000);
      function onMessage(event) {
        const data = event.data;
        if (!data || data.source !== SOURCE || data.to !== "parent" || data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(data.result || null);
      }
      window.addEventListener("message", onMessage);
      for (const frame of frames) {
        try {
          frame.contentWindow.postMessage({ source: SOURCE, to: "frame", type: "delete-one", id, requestId }, "*");
        } catch (error) {
          /* a cross-origin frame without the extension cannot answer */
        }
      }
    });
  }

  async function deleteThroughPage(id, options) {
    const opts = options || {};
    const started = signedDeletes;
    const fn = await findCallableDelete();
    if (fn) {
      logLine("info", `calling ${fn.label}`);
      try {
        const value = fn.fn.call(fn.owner, id);
        await Promise.race([
          Promise.resolve(value).then(() => true, (error) => { throw error; }),
          sleep(5000, () => true)
        ]);
      } catch (error) {
        logLine("fail", `page delete threw ${snippet(error && error.message || error)}`);
      }
      if (await waitForSigned(started, 3000)) {
        return { ok: true, status: 200, reason: "page handler signed the delete", summary: "", error: "" };
      }
      logLine("fail", `${fn.label} did not send a signed delete`);
    }
    if (opts.frames !== false) {
      const direct = await clickDeleteInFrames(id);
      if (direct === "clicked" && await waitForSigned(started, 4000)) {
        return { ok: true, status: 200, reason: "delete conversation control signed the delete", summary: "", error: "" };
      }
      const framed = await deleteInFrames(id);
      if (framed && framed.ok) return framed;
    }
    const clicked = await clickDeleteUi(id);
    if (clicked === "clicked" && await waitForSigned(started, 4000)) {
      return { ok: true, status: 200, reason: "delete conversation control signed the delete", summary: "", error: "" };
    }
    if (opts.allowNavigate && window.top === window && location.pathname.indexOf("/i/chat/") === -1) {
      return { navigate: true };
    }
    return null;
  }

  function loadJob() {
    try {
      const job = JSON.parse(sessionStorage.getItem(JOB_KEY) || "null");
      return job && Array.isArray(job.ids) ? job : null;
    } catch (error) {
      return null;
    }
  }

  function saveJob(job) {
    try {
      sessionStorage.setItem(JOB_KEY, JSON.stringify(job));
    } catch (error) {
      /* session storage can be blocked */
    }
  }

  function clearJob() {
    try {
      sessionStorage.removeItem(JOB_KEY);
    } catch (error) {
      /* ignore */
    }
  }

  async function resumeJob(job) {
    state.message = "Waiting for the chat inbox…";
    publish(false);
    await waitForInbox();
    const rows = conversationItems();
    const sample = rows[0] ? itemId(rows[0]) : "";
    const style = sample.indexOf(":") !== -1 ? "colon" : sample ? "hyphen" : "none";
    logLine("info", `inbox path ${location.pathname} rows ${rows.length} style ${style} sample ${sample.length}`);
    await removeAll(job.ids, job.delay, job);
  }

  async function deleteConversation(conv) {
    const id = String(conv.id);
    const preferXchat = conv.source === "xchat" || id.startsWith("g") || id.includes(":");
    if (!preferXchat) return deleteLegacy(id);
    if (!inboxPresent()) return { navigate: true };
    const row = conversationItems().find((el) => isShown(el));
    if (!row) return { ok: false, skip: true, status: 0, error: "", reason: "not on screen", summary: "" };
    pageDeleteRunning = true;
    try {
      const result = await deleteVisibleRow(row);
      return result.ok
        ? { ok: true, status: 200, reason: "chat row deleted", summary: "", error: "" }
        : { ok: false, status: 0, error: result.reason, reason: result.reason, blocked: true, summary: "" };
    } finally {
      pageDeleteRunning = false;
    }
  }

  async function removeAll(ids, delayMs, resume) {
    const token = ++runToken;
    const alive = () => token === runToken;
    const queue = (Array.isArray(ids) ? ids : []).filter(XNukeInbox.validConversationId);
    const delay = XNukeInbox.clampDelay(delayMs);
    const start = resume && Number.isInteger(resume.index) ? resume.index : 0;
    if (!queue.length) {
      state.phase = "error";
      state.message = "Select at least one conversation.";
      publish(true);
      return;
    }
    if (!csrfToken()) {
      state.phase = "error";
      state.message = "Sign in to X, then reload this tab.";
      publish(true);
      return;
    }
    state.phase = "delete";
    state.deleted = resume ? resume.deleted || 0 : 0;
    state.failed = resume ? resume.failed || 0 : 0;
    state.total = queue.length;
    state.message = `Deleting ${state.deleted} of ${queue.length}…`;
    logLine("info", `delete started for ${queue.length} conversations`);
    inboxCensus = null;
    publish(true);
    await discoverOps();
    if (queue.some((id) => id.includes(":") || id.startsWith("g"))) {
      if (!location.pathname.startsWith("/i/chat") && !inboxPresent()) {
        saveJob({ ids: queue, index: start, delay, deleted: state.deleted, failed: state.failed });
        state.message = "Opening the chat inbox…";
        publish(true);
        location.assign(`${location.origin}/i/chat`);
        return;
      }
      if (!inboxPresent()) await waitForInbox();
      await drainInbox(alive, delay);
      return;
    }
    let rateHits = 0;
    let repeated = "";
    let repeats = 0;
    for (let i = start; i < queue.length; i += 1) {
      if (!alive()) {
        state.phase = "idle";
        state.message = `Stopped. ${state.deleted} deleted, ${queue.length - i} left.`;
        publish(true);
        return;
      }
      const id = queue[i];
      const conv = state.conversations.get(id) || {
        id,
        source: "legacy",
        type: id.startsWith("g") ? "GROUP" : "DIRECT"
      };
      const result = await deleteConversation(conv);
      if (result && result.navigate) {
        saveJob({ ids: queue, index: i, delay, deleted: state.deleted, failed: state.failed });
        state.message = "Opening the chat inbox…";
        publish(true);
        location.assign(`${location.origin}/i/chat`);
        return;
      }
      if (!alive()) {
        state.phase = "idle";
        state.message = `Stopped. ${state.deleted} deleted, ${queue.length - i} left.`;
        publish(true);
        return;
      }
      if (result.ok) {
        state.deleted += 1;
        state.conversations.delete(id);
        rateHits = 0;
        repeated = "";
        repeats = 0;
      } else if (result.status === 401 || result.status === 403) {
        state.failed += 1;
        state.phase = "error";
        state.message = `X refused the session after ${state.deleted} deleted. Reload x.com and scan again.`;
        publish(true);
        return;
      } else if (result.status === 429 || result.status === 420) {
        rateHits += 1;
        if (rateHits >= 3) {
          state.phase = "error";
          state.message = `Rate limited after ${state.deleted} deleted. Wait, then scan and continue.`;
          publish(true);
          return;
        }
        state.message = `Rate limited. Waiting ${Math.ceil((result.waitMs || 60000) / 1000)}s…`;
        publish(true);
        if (!(await sleep(result.waitMs || 60000, alive))) {
          state.phase = "idle";
          state.message = `Stopped. ${state.deleted} deleted, ${queue.length - i} left.`;
          publish(true);
          return;
        }
        i -= 1;
        continue;
      } else if (result.skip) {
        state.failed += 1;
      } else if (result.blocked) {
        state.failed += 1;
        state.phase = "error";
        state.message = result.error;
        publish(true);
        return;
      } else {
        state.failed += 1;
        rateHits = 0;
        const reason = result.reason || result.error || `HTTP ${result.status}`;
        if (reason === repeated) repeats += 1;
        else {
          repeated = reason;
          repeats = 1;
        }
        if (repeats >= 3) {
          state.phase = "error";
          state.message = `Stopped after 3 identical failures. ${state.deleted} removed. ${reason}`;
          publish(true);
          return;
        }
      }
      state.message = `Removed ${state.deleted} of ${queue.length}${state.failed ? ` · ${state.failed} failed` : ""}`;
      publish(true);
      if (!result.skip && i < queue.length - 1 && !(await sleep(delay, alive))) {
        state.phase = "idle";
        state.message = `Stopped. ${state.deleted} deleted, ${queue.length - i - 1} left.`;
        publish(true);
        return;
      }
    }
    state.phase = state.failed && !state.deleted ? "error" : "done";
    state.message = state.deleted
      ? `Removed ${state.deleted} conversation${state.deleted === 1 ? "" : "s"}${state.failed ? `. ${state.failed} stayed. See the debug log.` : "."}`
      : "No conversations were removed. See the debug log.";
    publish(true);
  }

  function stop() {
    if (state.phase !== "scan" && state.phase !== "delete") return;
    runToken += 1;
    clearJob();
    state.phase = "idle";
    state.message = "Stopped.";
    publish(true);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data.to !== "page") return;
    const message = event.data;
    post({ type: "ack", requestId: message.requestId });
    if (message.type === "scan") void scan();
    else if (message.type === "stop") stop();
    else if (message.type === "delete") void removeAll(message.ids, message.delayMs);
    else if (message.type === "clear-log") {
      state.log = [];
      try { sessionStorage.removeItem(LOG_KEY); } catch (error) { /* ignore */ }
      publish(true);
    }
    else if (message.type === "refresh") publish(true);
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== SOURCE || data.to !== "frame" || data.type !== "delete-one") return;
    pageDeleteRunning = true;
    void (async () => {
      await waitForChatUi();
      cachedDeleter = undefined;
      const result = await deleteThroughPage(data.id, { allowNavigate: false, frames: false });
      pageDeleteRunning = false;
      if (event.source) {
        event.source.postMessage({ source: SOURCE, to: "parent", requestId: data.requestId, result: result || { ok: false } }, "*");
      }
    })();
  });

  loadOps();
  try {
    const savedLog = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
    if (Array.isArray(savedLog)) state.log = savedLog.slice(-120);
  } catch (error) {
    /* keep the empty log */
  }
  if (window.top === window) {
    publish(true);
    const job = loadJob();
    if (job && job.index < job.ids.length) void resumeJob(job);
  }
})();
