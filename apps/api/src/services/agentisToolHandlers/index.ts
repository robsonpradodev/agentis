/**
 * Agentis tool handlers — Plane 2 family registry.
 *
 * Each family file exports a `register(registry, deps)` function that wires
 * its tools into AgentisToolRegistry. The bootstrap calls them in a fixed
 * order so the registry is fully populated before any handler can execute.
 */

import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { registerOrientTools } from './orient.js';
import { registerExperimentTools } from './experimentTools.js';
import { registerSubjectTools } from './subjectTools.js';
import { registerCodeTools } from './codeTools.js';
import { registerInspectTools } from './inspect.js';
import { registerRunTools } from './run.js';
import { registerBuildTools } from './build.js';
import { registerEnvironmentTools } from './environment.js';
import { registerAgentTools } from './agent.js';
import { registerEphemeralTools } from './ephemeral.js';
import { registerCapabilityTools } from './capability.js';
import { registerCapabilityPlaneTools } from './capabilityPlane.js';
import { registerCommandTools } from './commandTools.js';
import { registerBlueprintTools } from './blueprint.js';
import { registerTaskSpineTools } from './taskSpine.js';
import { registerChannelTools } from './channel.js';
import { registerChannelTeamTools } from './channelTeam.js';
import { registerConversationTools } from './conversation.js';
import { registerAppPlanTools } from './appPlan.js';
import { registerAppGoalTools } from './appGoal.js';
import { registerStrategyTools } from './strategyTools.js';
import { registerOrchestrationRuleTools } from './orchestrationRules.js';
import { registerMediaTools } from './media.js';
import { registerBrowserTools } from './browser.js';
import { registerAssetTools } from './assets.js';
import { registerMcpBridgeTools } from './mcp.js';
import { registerIntegrationTools } from './integration.js';
import { registerAppDataTools } from './appData.js';
import { registerAppFrontendTools } from './appFrontend.js';
import { registerAppDoctorTools } from './appDoctor.js';
import { registerBrainTools } from './brain.js';
import { registerSpaceTools } from './spaceTools.js';
import { registerPermissionTools } from './permissions.js';
import { registerSuspensionTools } from './suspension.js';
import { registerFollowUpTools } from './followUp.js';
import { registerRelationshipQueryTools } from './relationshipQuery.js';

export function registerAllTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registerOrientTools(registry, deps);
  registerExperimentTools(registry, deps);
  registerSubjectTools(registry, deps);
  registerInspectTools(registry, deps);
  registerRunTools(registry, deps);
  registerBuildTools(registry, deps);
  registerAgentTools(registry, deps);
  registerEnvironmentTools(registry, deps);
  registerEphemeralTools(registry, deps);
  registerCapabilityTools(registry, deps);
  registerCapabilityPlaneTools(registry, deps);
  registerCommandTools(registry, deps);
  registerBlueprintTools(registry, deps);
  registerTaskSpineTools(registry, deps);
  registerChannelTools(registry, deps);
  registerChannelTeamTools(registry, deps);
  registerConversationTools(registry, deps);
  registerAppPlanTools(registry, deps);
  registerAppGoalTools(registry, deps);
  registerStrategyTools(registry, deps);
  registerOrchestrationRuleTools(registry, deps);
  registerMediaTools(registry, deps);
  registerBrowserTools(registry, deps);
  registerAssetTools(registry, deps);
  registerMcpBridgeTools(registry, deps);
  registerIntegrationTools(registry, deps);
  registerAppDataTools(registry, deps);
  registerAppFrontendTools(registry, deps);
  registerAppDoctorTools(registry, deps);
  registerBrainTools(registry, deps);
  registerSpaceTools(registry, deps);
  registerPermissionTools(registry, deps);
  registerSuspensionTools(registry, deps);
  registerFollowUpTools(registry, deps);
  registerRelationshipQueryTools(registry, deps);
  // Registered last, but its SDK surface is resolved lazily at call time, so it
  // still exposes every tool above (§3.7 code-mode over the whole registry).
  registerCodeTools(registry, deps);
}

export type { ToolHandlerDeps } from './deps.js';
