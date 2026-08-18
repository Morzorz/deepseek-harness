/**
 * Shared agentId → wecom userID publication between wecom-bridge and wx-plugin.
 *
 * The bridge writes one entry per DSH agent session it creates for a 企微 user;
 * the wx-plugin reads it to resolve the acting account (`WxOpContext.account`)
 * for a tool call owned by that agent. Both plugins run in the same process,
 * so a shared singleton module is the clean injection channel (no Cordis
 * service needed). Entries live for the lifetime of the owning agent and are
 * removed on bridge teardown.
 */
export const userByAgentId = new Map<string, string>()
