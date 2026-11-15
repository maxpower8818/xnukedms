const inbox = require("../inbox.js");
const xchat = require("../xchat.js");

let failed = 0;

function assert(condition, message) {
  if (condition) return;
  failed += 1;
  console.error("FAIL:", message);
}

const now = 1700000000000;

assert(inbox.asTimeMs(String(now)) === now, "millisecond timestamps stay in milliseconds");
assert(inbox.asTimeMs(String(Math.floor(now / 1000))) === now, "second timestamps convert to milliseconds");
assert(inbox.asTimeMs("nope") === null, "non-numeric timestamps are empty");
const snowflake = ((BigInt(now) - 1288834974657n) << 22n).toString();
assert(inbox.asTimeMs(snowflake) === now, "snowflake timestamps convert with the Twitter epoch");

assert(inbox.selfIdFromCookie("guest_id=1; twid=u%3D42; ct0=abc") === "42", "viewer id comes from the twid cookie");
assert(inbox.clampDelay(100) === 500, "delay has a floor");
assert(inbox.clampDelay(9000) === 5000, "delay has a ceiling");
assert(inbox.clampDelay("nope") === 1200, "invalid delay falls back");
assert(inbox.validConversationId("123-456"), "legacy one-to-one ids are accepted");
assert(inbox.validConversationId("10:20"), "X Chat ids use a colon");
assert(inbox.validConversationId("10:10"), "a self chat id is accepted");
assert(inbox.validConversationId("g123"), "group ids are accepted");
assert(!inbox.validConversationId("123 456"), "ids with spaces are rejected");
assert(!inbox.validConversationId(""), "empty ids are rejected");

assert(inbox.retryWaitMs(200, 0, now) === 0, "successful responses do not wait");
assert(inbox.retryWaitMs(429, Math.floor(now / 1000) + 30, now) === 31000, "rate limit waits until the reset header");
assert(inbox.retryWaitMs(429, Math.floor(now / 1000) + 20 * 60, now) === 15 * 60 * 1000, "rate limit wait is capped");
assert(inbox.retryWaitMs(429, "", now) === 60000, "missing reset header waits one minute");

assert(inbox.cursorMoved("10", { status: "HAS_MORE", minEntryId: "9" }), "a new cursor advances");
assert(!inbox.cursorMoved("10", { status: "HAS_MORE", minEntryId: "10" }), "a repeated cursor does not advance");
assert(!inbox.cursorMoved("10", { status: "AT_END", minEntryId: "9" }), "the end cursor stops paging");

assert(inbox.responseError({ errors: [{ message: "Bad" }, { code: 88 }] }) === "Bad; 88", "graphql errors are joined");
assert(inbox.needsDeviceSignature("missing action signature"), "signature failures are recognized");
assert(!inbox.needsDeviceSignature("X returned DeleteConversationResponse and did not remove the conversation."), "an unconfirmed delete is not a signature failure");
assert(!inbox.needsDeviceSignature("HTTP 404"), "ordinary failures are not signature failures");

const legacy = inbox.parseLegacyPage({
  inbox_initial_state: {
    users: {
      "1": { name: "Me", screen_name: "me" },
      "2": { name: "Ada Lovelace", screen_name: "ada" },
      "3": { name: "Grace", screen_name: "grace" }
    },
    conversations: {
      "1-2": {
        conversation_id: "1-2",
        type: "ONE_TO_ONE",
        trusted: true,
        sort_timestamp: String(now - 2 * 86400000),
        participants: [{ user_id: "1" }, { user_id: "2" }],
        text: "secret hello"
      },
      "1-3": {
        conversation_id: "1-3",
        type: "ONE_TO_ONE",
        trusted: false,
        low_quality: true,
        sort_timestamp: String(now - 10 * 86400000),
        participants: [{ user_id: "1" }, { user_id: "3" }]
      },
      "g9": {
        conversation_id: "g9",
        type: "GROUP_DM",
        name: "Project",
        sort_timestamp: String(now),
        participants: [{ user_id: "1" }, { user_id: "2" }]
      },
      "1-4": {
        conversation_id: "1-4",
        type: "ONE_TO_ONE",
        trusted: false,
        sort_timestamp: String(now - 40 * 86400000),
        participants: [{ user_id: "1" }, { user_id: "4" }]
      }
    },
    inbox_timelines: {
      trusted: { status: "HAS_MORE", min_entry_id: "50" },
      untrusted: { status: "AT_END", min_entry_id: "0" }
    }
  }
});

assert(legacy.conversations.length === 4, "legacy page keeps every conversation");
assert(!Object.hasOwn(legacy.conversations[0], "text"), "message text is not kept");
assert(legacy.initialCursors.trusted.status === "HAS_MORE", "trusted cursor is kept");
assert(legacy.initialCursors.untrusted_low_quality.status === "AT_END", "missing timelines are finished");
assert(inbox.bucketFor(legacy.conversations.find((conv) => conv.id === "1-2")) === "primary", "trusted direct messages are primary");
assert(inbox.bucketFor(legacy.conversations.find((conv) => conv.id === "1-3")) === "hidden", "low-quality requests are hidden");
assert(inbox.bucketFor(legacy.conversations.find((conv) => conv.id === "1-4")) === "requests", "other untrusted messages are requests");
assert(inbox.bucketFor(legacy.conversations.find((conv) => conv.id === "g9")) === "groups", "group conversations are groups");
assert(inbox.labelFor(legacy.conversations.find((conv) => conv.id === "1-2"), legacy.users, "1") === "Ada Lovelace @ada", "labels use the other participant");
assert(inbox.labelFor(legacy.conversations.find((conv) => conv.id === "g9"), legacy.users, "1") === "Project", "group labels use the group name");

const index = inbox.createIndex();
assert(inbox.mergeParsed(index, legacy) === 4, "the first merge counts new conversations");
assert(inbox.mergeParsed(index, {
  users: {},
  conversations: [{ id: "1-2", type: "DIRECT", trusted: true, lowQuality: false, muted: false, sortAt: null, name: "", participantIds: ["1", "2"], source: "xchat" }]
}) === 0, "merging the same id does not count it twice");
assert(index.conversations.get("1-2").source === "xchat", "an X Chat copy wins the source");
inbox.mergeParsed(index, { users: { "2": { id: "2", name: "", handle: "" } }, conversations: [] });
assert(index.users["2"].name === "Ada Lovelace" && index.users["2"].handle === "ada", "blank user records do not erase names");

const presented = inbox.presentConversation(index.conversations.get("1-3"), legacy.users, "1", now);
assert(presented.label === "Grace @grace", "presented rows name the other person");
assert(presented.bucket === "hidden", "presented rows keep the bucket");
assert(inbox.whenLabel(now - 2 * 86400000, now) === "2 days ago", "age is in days");
assert(inbox.matchesFilter(presented, { buckets: ["hidden"], olderThanDays: 7 }, now), "old hidden messages match");
assert(!inbox.matchesFilter(presented, { buckets: ["primary"], olderThanDays: 7 }, now), "bucket filters apply");
assert(!inbox.matchesFilter(presented, { buckets: ["hidden"], olderThanDays: 30 }, now), "newer than the age cutoff is excluded");
assert(!inbox.matchesFilter({ ...presented, sortAt: null, label: "Grace @grace" }, { buckets: ["hidden"], olderThanDays: 1 }, now), "undated conversations are left out of an age filter");
assert(inbox.matchesFilter(presented, { buckets: ["hidden"], query: "@grace" }, now), "name search matches the label");
assert(!inbox.matchesFilter(presented, { buckets: ["hidden"], query: "secret hello" }, now), "search cannot match message text that was never stored");

assert(inbox.summarizeBody({ errors: [{ message: "Could not delete" }], encoded_message_events: "ciphertext-blob" }).includes("Could not delete"), "debug summaries keep error text");
assert(inbox.summarizeBody({ encoded_message_events: "ciphertext-blob" }).includes("<redacted>"), "debug summaries redact message payloads");
assert(!inbox.xchatDeleteVerdict({ data: { xchat_delete_conversation: null } }).ok, "an empty mutation is not a confirmed delete");
assert(inbox.xchatDeleteVerdict({ data: { xchat_delete_conversation: { error_code: "DependencyError" } } }).error === "error_code DependencyError", "nested delete error codes fail the verdict");
assert(!inbox.xchatDeleteVerdict({ data: { xchat_delete_conversation: { __typename: "DeleteConversationResponse" } } }).ok, "a response type name does not mean the chat was removed");
assert(inbox.deleteFieldReport({ data: { xchat_delete_conversation: { __typename: "DeleteConversationResponse" } } }).includes("conversation_id=absent"), "a missing delete field is reported as absent");
assert(inbox.deleteFieldReport({ data: { xchat_delete_conversation: { __typename: "DeleteConversationResponse", error_code: null } } }).includes("error_code=null"), "a null delete field stays visible");
assert(inbox.xchatDeleteVerdict({ data: { xchat_delete_conversation: { __typename: "DeleteConversationResponse", is_deleted_by_viewer: true } } }).ok, "a viewer-deleted flag confirms the delete");
assert(!inbox.xchatDeleteVerdict({ data: { xchat_delete_conversation: {} } }).ok, "an empty object does not confirm a delete");
assert(inbox.legacyStillPresent({ conversation_timeline: { conversations: { "1-2": { conversation_id: "1-2" } } } }, "1-2"), "verify sees a conversation that is still returned");
assert(!inbox.legacyStillPresent({ conversation_timeline: { conversations: {} } }, "1-2"), "an empty conversation map is not still present");

const xchatPage = inbox.parseXchatPage({
  data: {
    get_initial_chat_page: {
      items: [
        {
          is_deleted_by_viewer: true,
          conversation_detail: { __typename: "XChatDirectConversationDetail", conversation_id: "9-8", participants_results: [] }
        },
        {
          conversation_detail: {
            __typename: "XChatDirectConversationDetail",
            conversation_id: "5-6",
            participants_results: [
              { rest_id: "5", result: { rest_id: "5", core: { name: "Me", screen_name: "me" } } },
              { rest_id: "6", result: { rest_id: "6", core: { name: "Lin", screen_name: "lin" } } }
            ]
          }
        },
        {
          conversation_detail: {
            __typename: "XChatGroupConversationDetail",
            conversation_id: "g7",
            group_metadata: {
              group_name: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
              updated_at_msec: String(now - 86400000)
            },
            group_members_results: [{ rest_id: "5" }, { rest_id: "6" }]
          }
        }
      ],
      inboxCursor: { __typename: "XChatGetInboxPageContinueCursor", cursor_id: "cursor-2", graph_snapshot_id: "snap" }
    }
  }
});

assert(xchatPage.conversations.length === 3, "inbox rows stay listed when is_deleted_by_viewer is set");
assert(xchatPage.itemCount === 3, "every inbox item is counted");
assert(xchatPage.cursor.cursorId === "cursor-2" && xchatPage.cursor.done === false, "X Chat continue cursors are kept");

const mixed = inbox.parseXchatPage({
  data: {
    get_initial_chat_page: {
      items: [
        { conversation_id: "11-12", participants_results: [{ rest_id: "11", result: { rest_id: "11", core: { name: "Ann", screen_name: "ann" } } }] },
        { node: { conversation_detail: { __typename: "XChatDirectConversationDetail", conversation_id: "13-14", participants_results: [] } } },
        { conversation: { conversation_id: "15-16" } }
      ]
    }
  }
});
assert(mixed.conversations.map((conv) => conv.id).join(",") === "11-12,13-14,15-16", "conversation ids are read from the item, a node wrapper, or a nested conversation");
assert(inbox.labelFor(mixed.conversations[0], mixed.users, "11") === "Ann @ann", "participants on the item itself are labeled");
assert(inbox.labelFor(xchatPage.conversations[1], xchatPage.users, "5") === "Lin @lin", "X Chat labels use participant names");
assert(inbox.labelFor(xchatPage.conversations[2], xchatPage.users, "5") === "Group · 2", "encrypted group titles are not shown");
assert(xchatPage.cursor.cursorId === "cursor-2" && xchatPage.cursor.done === false, "X Chat continue cursors are kept");
assert(inbox.inferSelfId(legacy.conversations) === "1", "the viewer is the participant in every direct conversation");

assert(xchat.INITIAL_QUERY.includes("query GetInitialXChatPageQuery"), "the X Chat inbox query is present");
assert(xchat.INITIAL_QUERY.includes("fragment InboxPageFragment"), "the inbox fragment is present");
assert(xchat.inboxPageQuery().includes("get_inbox_page(continue_cursor: $continue_cursor"), "paging sends continue_cursor");
assert(xchat.inboxPageQuery().includes("$continue_cursor"), "paging declares the required cursor variable");
assert(xchat.inboxPageQuery().includes("fragment InboxPageFragment"), "paging reuses the inbox fragment");

const blankIds = inbox.parseXchatPage({
  data: {
    get_initial_chat_page: {
      items: [
        {
          is_deleted_by_viewer: false,
          conversation_detail: {
            __typename: "XChatDirectConversationDetail",
            conversation_id: null,
            is_archived: false,
            is_muted: false,
            participants_results: [
              { rest_id: "20", result: { rest_id: "20", core: { name: "Bea", screen_name: "bea" } } }
            ]
          }
        },
        {
          conversation_detail: {
            __typename: "XChatDirectConversationDetail",
            conversation_id: null,
            participants_results: [
              { result: { rest_id: "9", core: { name: "Cy", screen_name: "cy" } } }
            ]
          }
        },
        {
          conversation_detail: {
            __typename: "XChatDirectConversationDetail",
            conversation_id: null,
            participants_results: [
              { rest_id: "30", result: { rest_id: "30", core: { name: "Dee", screen_name: "dee" } } },
              { rest_id: "40", result: { rest_id: "40", core: { name: "Eve", screen_name: "eve" } } }
            ]
          }
        }
      ]
    }
  }
}, "10");
assert(blankIds.conversations.map((conv) => conv.id).sort().join(",") === "10:20,9:10", "a null conversation id is rebuilt as smaller:larger");
assert(blankIds.itemCount === 3 && blankIds.conversations.length === 2, "a chat with more than two participants is not guessed");
assert(inbox.labelFor(blankIds.conversations.find((conv) => conv.id === "10:20"), blankIds.users, "10") === "Bea @bea", "synthesized chats keep the other person's name");
assert((blankIds.skippedOutline || "").includes("no-id=1"), "a skipped chat names the reason");
assert((blankIds.skippedOutline || "").includes("id=null"), "a skipped chat shows a null conversation id");
assert((blankIds.skippedOutline || "").includes("participants=30+40"), "a skipped chat lists the participant ids");
assert((blankIds.skippedOutline || "").includes("self=10"), "a skipped chat shows which viewer id was used");
assert((blankIds.skippedOutline || "").includes("conversation_id=null"), "a skipped chat outline shows conversation_id was null");

const deletedOnly = inbox.parseXchatPage({
  data: {
    get_initial_chat_page: {
      items: [
        {
          is_deleted_by_viewer: true,
          conversation_detail: {
            __typename: "XChatDirectConversationDetail",
            conversation_id: "1:2",
            is_deleted_by_viewer: true
          }
        }
      ]
    }
  }
}, "1");
assert(deletedOnly.conversations.length === 1 && deletedOnly.conversations[0].id === "1:2", "a deleted flag does not drop a visible inbox row");
assert(deletedOnly.skippedOutline === "", "kept rows are not reported as skipped");
assert(!inbox.validConversationId("null"), "the string null is not a conversation id");

const colonIds = inbox.parseXchatPage({
  data: {
    get_initial_chat_page: {
      items: [
        {
          conversation_detail: {
            __typename: "XChatDirectConversationDetail",
            conversation_id: "1000000000000000001:1000000000000000001",
            participants_results: [
              { rest_id: "1000000000000000001", result: { rest_id: "1000000000000000001", core: { name: "Me", screen_name: "me" } } }
            ]
          }
        },
        {
          conversation_detail: {
            conversation_id: "2000000000000000002:1000000000000000001",
            participants_results: [
              { rest_id: "2000000000000000002", result: { rest_id: "2000000000000000002", core: { name: "Ann", screen_name: "ann" } } }
            ]
          }
        }
      ]
    }
  }
}, "1000000000000000001");
assert(colonIds.conversations.map((conv) => conv.id).join(",") === "1000000000000000001:1000000000000000001,2000000000000000002:1000000000000000001", "colon conversation ids are kept as returned");
assert(xchat.DELETE_QUERY.includes("xchat_delete_conversation"), "the delete mutation is bundled");
assert(xchat.DELETE_ID === "YHFgPwrwwnml8gF8H1YhCA", "the delete mutation id is the public operation id");
assert(!xchat.INITIAL_QUERY.includes("secret"), "the shipped query is not a message fixture");

const timeline = inbox.parseLegacyPage({
  inbox_timeline: {
    status: "HAS_MORE",
    min_entry_id: "40",
    conversations: {},
    users: {}
  }
});
assert(timeline.initialCursors === null, "timeline pages are not treated as the initial inbox");
assert(inbox.cursorMoved("50", timeline.pageCursor), "timeline pages expose the next cursor");

const forms = inbox.conversationIdForms("3000000000000000003:1000000000000000001");
assert(forms.indexOf("1000000000000000001:3000000000000000003") !== -1, "a pair id matches either participant order");
assert(forms.indexOf("3000000000000000003-1000000000000000001") !== -1, "a pair id matches the hyphen form");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("ok");
