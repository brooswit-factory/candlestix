// Exit codes for the candlestix CLI's OWN pre-attach path.
//
// These four codes are the epic's accepted default, and this story uses
// them without deviation: 0 success, 1 refusal, 2 usage error, 3 daemon
// unreachable.
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
