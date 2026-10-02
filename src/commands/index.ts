import { apiCommand } from "./api.js";
import { loginCommand, logoutCommand, profilesCommand, whoamiCommand } from "./auth.js";
import { catalog } from "./catalog.js";
import { completionCommand } from "./completion.js";
import { domainsVerifyCommand } from "./domains-verify.js";
import { commandsCommand, versionCommand } from "./info.js";
import { logsTailCommand } from "./logs-tail.js";
import { sendCommand } from "./send.js";

catalog.top.push(
  sendCommand,
  loginCommand,
  logoutCommand,
  whoamiCommand,
  profilesCommand,
  apiCommand,
  commandsCommand,
  completionCommand,
  versionCommand,
);
catalog.extensions.push(domainsVerifyCommand, logsTailCommand);

export { catalog };
