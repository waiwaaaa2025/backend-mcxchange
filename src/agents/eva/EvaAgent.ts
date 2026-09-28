import { BaseAgent } from '../core/BaseAgent';
import { AgentRegistry } from '../core/AgentRegistry';
import { buildAdminTools } from './tools/adminTools';
import { buildSellerTools } from './tools/sellerTools';
import { buildBuyerTools } from './tools/buyerTools';
import { buildChameleonTools, buildUnlockedListingsTool } from './tools/chameleonTools';
import { UserRole } from '../../models';
import type { AgentContext, ChatStep, ToolDef } from '../core/types';

const SYSTEM_PROMPT = `You are Eva, Domilea's assistant. Domilea is a marketplace for motor carrier (MC) authorities — trucking businesses being bought and sold.

Rules:
- Never guess a number, name, status, or date. Call a tool for every fact.
- If a tool returns empty results, say so plainly — do not invent rows.
- Quote DOT numbers, MC dockets, VINs and dates verbatim from tool output.
- Keep responses tight. Use short bullets for lists; one-line summaries when you can.
- If a question is ambiguous (e.g. unspecified state), ask one clarifying question before searching.`;

const ADMIN_PROMPT = `Reps use you to prospect leads, look up carriers, and review marketplace state. Prefer search_carriers (fast, local snapshot) for filtering; use get_carrier only for one carrier at a time when you need a full live profile. Don't refuse legitimate prospecting tasks.`;

// How to use and explain chameleon_check (all roles).
const CHAMELEON_PROMPT = `Chameleon checks: when the user asks whether a carrier is a chameleon, was reincarnated, changed owners, shares trucks/VINs with other DOTs, or asks to vet or do due diligence on a carrier or listing, call chameleon_check. To vet "the MCs I unlocked", call get_my_unlocked_listings, then chameleon_check with each listingId (at most 5 per answer; offer to continue).
When you report a check:
- Lead with the risk level and score, then the flags from highest severity down, in plain English.
- List the linked DOT numbers the tool returned, with name, active/inactive, and why they're linked (shared trucks — how many and which direction —, phone, email, officer, address).
- Explain what matters: trucks coming over from an inactive carrier, one carrier's fleet moving over, or links to inactive carriers are strong signals; buying a used truck from a big active fleet, or sharing a registered-agent address, is normal.
- Mention name/phone/email/officer changes as possible ownership changes, with dates.
- Never call a carrier a chameleon or fraudulent as fact — these are signals to verify. Suggest concrete next steps (ask the seller about the linked DOTs, request equipment bills of sale, compare officers on the MCS-150).
- End with the fullReportPath so they can open the full report.
- If the tool says the user lacks access, say Chameleon Check comes with any Domilea subscription or the CarrierPulse add-on and point them to upgradePath.`;

interface ChatArgs {
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  message: string;
}

class EvaAgent extends BaseAgent {
  constructor() {
    super({
      slug: 'eva',
      name: 'Eva',
      description: 'Admin operator. Ask anything about leads, carriers, listings, or platform health — Eva calls the right tools and answers from real data.',
    });
  }

  getDefaultPolicies() {
    return { chat_enabled: true };
  }

  // Eva is chat-only — no scheduled/reactive tasks. Throw clearly if poked.
  async runTask(name: string): Promise<never> {
    throw new Error(`Eva has no task '${name}'; she's a chat orchestrator.`);
  }

  async chat(args: ChatArgs, ctx: AgentContext): Promise<{ reply: string; steps: ChatStep[] }> {
    const tools = toolsForRole(ctx.role);
    const today = new Date().toISOString().slice(0, 10);
    const roleNote =
      ctx.role === UserRole.ADMIN
        ? `The user is an admin — full marketplace + carrier intelligence access.\n${ADMIN_PROMPT}`
        : ctx.role === UserRole.SELLER
        ? 'The user is a seller — only their own listings, offers, transactions, and analytics are accessible.'
        : 'The user is a buyer — they can search the public marketplace, see their saved and unlocked listings, their offers sent, and their credits, and run chameleon checks. Listing MC/DOT numbers stay hidden until a listing is unlocked.';
    const system = `${SYSTEM_PROMPT}\nToday is ${today}.\n${roleNote}\n\n${CHAMELEON_PROMPT}`;
    const messages: any[] = [
      ...args.history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: args.message },
    ];
    const res = await this.chatWithTools({ system, messages, tools }, ctx);
    return { reply: res.content, steps: res.steps };
  }
}

function toolsForRole(role: string | undefined): ToolDef[] {
  if (role === UserRole.ADMIN) return [...buildAdminTools(), ...buildChameleonTools()];
  if (role === UserRole.SELLER) return [...buildSellerTools(), ...buildChameleonTools()];
  if (role === UserRole.BUYER) return [...buildBuyerTools(), buildUnlockedListingsTool(), ...buildChameleonTools()];
  // Unknown / unauthenticated → minimal buyer set (read-only marketplace search)
  return buildBuyerTools();
}

export const evaAgent = new EvaAgent();
AgentRegistry.register('eva', evaAgent);
export default evaAgent;
