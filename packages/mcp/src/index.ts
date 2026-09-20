/**
 * `jevcore-mcp` — TypeSafe Jev over the Model Context Protocol.
 *
 * A second entry point over the same core as the DSH plugin: one decision
 * layer, two transports. Nothing here re-implements a judgment.
 */

export { buildRuntime, chooseProvider, type McpRuntime } from './runtime.js'
export { createServer } from './server.js'
export { runAsk, runCheck, runRank, SYNTHETIC_WARNING, toQuestions } from './tools.js'
export type { AskInput, CheckInput, QuestionInput, RankInput } from './tools.js'
