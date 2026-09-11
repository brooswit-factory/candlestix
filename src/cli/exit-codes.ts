// Exit codes for the candlestix CLI's OWN pre-attach path.
//
// These four codes are the epic's accepted default: 0 success, 1 refusal,
// 2 usage error, 3 daemon unreachable/unintelligible.
//
// EXIT_REFUSAL's exact meaning, settled by the epic (CNDLX-31): "candlestix
// asked and was told no" — an ordinary refusal, including a delete the
// operator declined at the confirmation prompt. It does NOT cover every
// `ok:false` from the daemon: a daemon-SIDE failure (the store, a session
// lookup, spawning) means the request was fine and the daemon broke, so it
// exits EXIT_DAEMON_UNREACHABLE instead — a script reading `1` there would
// wrongly conclude the request was rejected and not retry. See
// src/cli/render.ts's `classifyRefusalExitCode`, which does this
// classification through the contract's own `statusForErrorKind` rather
// than a hand-written kind list here.
//
// CRITICAL BOUNDARY, stated here because every caller of these constants
// needs to know it: these codes govern ONLY the pre-attach path, including
// every attach-target refusal. Once `candlestix <id|name>` successfully
// hands the terminal to `claude attach`, the process's exit code becomes
// `claude attach`'s OWN exit status — which can be any value, including
// ones that collide with the four below. That collision is required
// behaviour (the epic's ruling), not a bug: propagating the real attach
// session's exit status is what lets a script tell whether the attached
// session itself failed. See README's exit-code table for the
// candlestix-versus-`claude attach` provenance split a script needs.
export const EXIT_SUCCESS = 0;
export const EXIT_REFUSAL = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_DAEMON_UNREACHABLE = 3;
