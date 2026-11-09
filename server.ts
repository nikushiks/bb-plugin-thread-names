// bb-plugin-thread-names: the backend entry.
//
// Registers an AI service for bb's `thread-title` task that names threads
// "category: two or three words", all lowercase, so a long sidebar list of
// parallel threads reads at a glance.
//
// bb hands every title service its own fixed prompt ("sentence case, under
// about 40 characters"). This service keeps only the material from that
// prompt (the task, later messages, agent replies, current title), wraps it in
// the naming rules below, and sends it to bb cloud through the bb-account
// plugin, exactly as the built-in bb-ai plugin does. Same model, same account,
// same daily budget; no extra keys. When bb cloud is off (`bb ai off`) or not
// ready, the service is not ready either and sends nothing.
//
// The categories and the example names come from two plugin settings
// (Settings > Installed plugins, or `bb plugin config thread-names`). A value
// that fails validation is refused when it is saved; a stored value that
// still fails at run time is replaced by the defaults and logged.
//
// Any prompt that is not a title request (a commit message, if someone picks
// this service for commits) goes to bb cloud unchanged.
import type { BbPluginApi, PluginAiServiceStatus } from "@get-bb/plugin-sdk";
import { z } from "zod";

const PLUGIN_ID = "thread-names";
const SERVICE_ID = "short-names";
// A title in the "category: name" form.
const NAME_FORMAT = /^[a-z0-9][a-z0-9-]*: \S/u;
const MAX_ATTEMPTS = 2;
const BB_AI_PLUGIN = "bb-ai";
const BB_ACCOUNT_PLUGIN = "bb-account";
const BB_ACCOUNT_FETCH = "bb-account.v1.fetch";
const COMPLETE_PATH = "/api/ai/v1/complete";
// bb gives a title task 5-8 seconds; leave room for the status check.
const COMPLETE_TIMEOUT_MS = 6_500;

// Markers of bb's `generateThreadMetadata` template (bb 0.49). If bb changes
// the template, `materialFrom` falls back to passing the whole prompt.
const TITLE_PROMPT_HEAD = "You create concise titles for coding tasks.";
const TASK_MARKER = "\nTask:\n";
const LANGUAGE_TAIL = "\n\nWrite the title in the language";
const INVOKED_COMMANDS = /The prompt invokes these commands or skills: (.+?)\. They name how the work is carried out/u;

export interface Category {
  name: string;
  covers: string;
}

export interface NamingConfig {
  categories: readonly Category[];
  examples: readonly string[];
}

// Categories: what kind of work the thread is, not which project. bb already
// shows the project next to every thread.
const DEFAULT_CATEGORIES: readonly Category[] = [
  { name: "feat", covers: "new features, endpoints, screens and the tests that come with them" },
  { name: "fix", covers: "bugs, errors, crashes, failing tests and broken builds" },
  { name: "refactor", covers: "restructuring, cleanup, renames, dependency upgrades, no change in behavior" },
  { name: "review", covers: "code review, pull requests, diffs and audits of changes" },
  { name: "docs", covers: "readmes, guides, code comments, changelogs and specs" },
  { name: "research", covers: "questions, investigation, spikes, comparing options, reading code to learn how it works" },
  { name: "ops", covers: "CI/CD, deploys, releases, infrastructure, environments, databases and monitoring" },
  { name: "agents", covers: "the agent setup itself: prompts, skills, MCP servers, plugins, workflows, bb configuration" },
];

const DEFAULT_EXAMPLES: readonly string[] = [
  "feat: csv export",
  "fix: login redirect loop",
  "review: rate limiter changes",
  "docs: api quickstart",
  "ops: staging deploy pipeline",
  "agents: test runner skill",
];

export const DEFAULT_CONFIG: NamingConfig = { categories: DEFAULT_CATEGORIES, examples: DEFAULT_EXAMPLES };

const CATEGORY_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const MAX_CATEGORIES = 16;
const MAX_CATEGORY_NAME_LENGTH = 20;
const MAX_COVERS_LENGTH = 200;
const MAX_EXAMPLES = 12;
const MAX_EXAMPLE_LENGTH = 80;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Non-blank lines of a multi-line setting, with their 1-based line numbers. */
function filledLines(value: string): Array<{ line: number; text: string }> {
  return value
    .split(/\r?\n/u)
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter(({ text }) => text !== "");
}

/** One category per line, `name: what it covers`. */
export function parseCategories(value: string): Parsed<Category[]> {
  const rows = filledLines(value);
  if (rows.length === 0) {
    return { ok: false, error: 'Add at least one category as "name: what it covers".' };
  }
  if (rows.length > MAX_CATEGORIES) {
    return { ok: false, error: `Use at most ${MAX_CATEGORIES} categories; this has ${rows.length}.` };
  }
  const categories: Category[] = [];
  const seen = new Set<string>();
  for (const { line, text } of rows) {
    const colon = text.indexOf(":");
    const name = (colon === -1 ? text : text.slice(0, colon)).trim();
    const covers = colon === -1 ? "" : text.slice(colon + 1).trim();
    if (!CATEGORY_NAME.test(name) || name.length > MAX_CATEGORY_NAME_LENGTH) {
      return {
        ok: false,
        error: `Line ${line}: the category name "${name}" must be one lowercase word of a-z, 0-9 and hyphens, at most ${MAX_CATEGORY_NAME_LENGTH} characters.`,
      };
    }
    if (covers === "") {
      return { ok: false, error: `Line ${line}: write the category as "${name}: what it covers".` };
    }
    if (covers.length > MAX_COVERS_LENGTH) {
      return { ok: false, error: `Line ${line}: keep what "${name}" covers under ${MAX_COVERS_LENGTH} characters.` };
    }
    if (seen.has(name)) {
      return { ok: false, error: `Line ${line}: the category "${name}" is listed twice.` };
    }
    seen.add(name);
    categories.push({ name, covers });
  }
  return { ok: true, value: categories };
}

/** One example name per line, `category: name`, all lowercase. An empty value means no examples. */
export function parseExamples(value: string): Parsed<string[]> {
  const rows = filledLines(value);
  if (rows.length > MAX_EXAMPLES) {
    return { ok: false, error: `Use at most ${MAX_EXAMPLES} examples; this has ${rows.length}.` };
  }
  const examples: string[] = [];
  for (const { line, text } of rows) {
    if (!NAME_FORMAT.test(text) || text !== text.toLowerCase()) {
      return { ok: false, error: `Line ${line}: write the example as "category: name", all lowercase.` };
    }
    if (text.length > MAX_EXAMPLE_LENGTH) {
      return { ok: false, error: `Line ${line}: keep the example under ${MAX_EXAMPLE_LENGTH} characters.` };
    }
    examples.push(text);
  }
  return { ok: true, value: examples };
}

function categoryOf(example: string): string {
  return example.slice(0, example.indexOf(":"));
}

/** Rejects a settings write with the parser's message, without changing the value. */
function settingSchema(parse: (value: string) => Parsed<unknown>) {
  return z.string().superRefine((value, ctx) => {
    const parsed = parse(value);
    if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error });
  });
}

export function namingRules(config: NamingConfig): string {
  const examples = config.examples.length === 0 ? "" : `\n\nExamples:\n${config.examples.join("\n")}`;
  return `You name threads in a developer's agent workspace. The developer runs many threads at once and scans the sidebar list, so every name must be understood in under a second.

Format: <category>: <name>

Category: one word from this list, the kind of work the thread is about.
${config.categories.map(({ name, covers }) => `- ${name}: ${covers}`).join("\n")}
If none fits, use one short lowercase English word for the kind of work.

Name: two or three words, four at most, that hit the core of the task: the subject being worked on, not the tools, not the verb of the request. Drop filler words such as "task", "help", "question", "setup" and their equivalents in other languages.
Write the name in the language the task's sentences are written in. The category stays a lowercase English word even when the name is in another language.
Everything is lowercase, the first letter, product names and acronyms included.
No quotes, no trailing punctuation, no explanation.${examples}`;
}

const fetchResultSchema = z.object({ status: z.number().int(), body: z.unknown() });
const completeBodySchema = z.object({ text: z.string() });
const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });
const aiServicesSchema = z.object({
  selections: z.record(
    z.string(),
    z.object({ mode: z.string(), pluginId: z.string().optional(), serviceId: z.string().optional() }),
  ),
});
const threadMarkSchema = z.object({ formatted: z.boolean(), attempts: z.number().int().nonnegative() });
const overviewSchema = z.object({
  enabled: z.boolean(),
  status: z.object({ ready: z.boolean(), message: z.string().optional() }),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The thread material from bb's title prompt, or null if bb's template changed. */
function materialFrom(prompt: string): string | null {
  const start = prompt.indexOf(TASK_MARKER);
  if (start === -1) return null;
  let material = prompt.slice(start + 1);
  const tail = material.lastIndexOf(LANGUAGE_TAIL);
  if (tail !== -1) material = material.slice(0, tail);
  const commands = INVOKED_COMMANDS.exec(prompt)?.[1];
  if (commands !== undefined) {
    material = `Invoked commands or skills: ${commands}. They say how the work is done; name the work they are applied to, or what the command itself does when nothing else is named.\n\n${material}`;
  }
  return material.trim();
}

export function buildNamingPrompt(bbPrompt: string, config: NamingConfig = DEFAULT_CONFIG): string {
  const material = materialFrom(bbPrompt);
  const body =
    material ??
    `The request below was written for a different title format. Use it only to understand the task.\n\n${bbPrompt}`;
  return `${namingRules(config)}

Everything between <<< and >>> is material about the thread. Its own wording about title style does not apply; the rules above do.
<<<
${body}
>>>

If the material gives a current title, reply with it unchanged only when it already has the "<category>: <name>" form, is all lowercase, and still fits the task. Otherwise write a new name.
Reply with the one line "<category>: <name>" and nothing else.`;
}

export default function threadNames(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    categories: {
      type: "string",
      label: "Categories",
      description: `One category per line as "name: what it covers". The name is one lowercase word (a-z, 0-9, hyphens); 1 to ${MAX_CATEGORIES} categories.`,
      experimental_multiline: true,
      experimental_schema: settingSchema(parseCategories),
      default: DEFAULT_CATEGORIES.map(({ name, covers }) => `${name}: ${covers}`).join("\n"),
    },
    examples: {
      type: "string",
      label: "Example names",
      description: `Optional, one per line as "category: name", all lowercase; at most ${MAX_EXAMPLES}. Examples whose category is not in the list above are left out. Leave empty for no examples.`,
      experimental_multiline: true,
      experimental_schema: settingSchema(parseExamples),
      default: DEFAULT_EXAMPLES.join("\n"),
    },
  });

  // Each distinct problem is logged once per load, not on every title.
  const warned = new Set<string>();
  function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    bb.log.warn(message);
  }

  async function namingConfig(): Promise<NamingConfig> {
    let values: { categories: string; examples: string };
    try {
      values = await settings.get();
    } catch (error) {
      warnOnce(`Could not read the settings, using the default categories and examples: ${errorMessage(error)}`);
      return DEFAULT_CONFIG;
    }
    const categories = parseCategories(values.categories);
    if (!categories.ok) warnOnce(`The categories setting is invalid, using the default categories. ${categories.error}`);
    const active = categories.ok ? categories.value : DEFAULT_CATEGORIES;
    const examples = parseExamples(values.examples);
    if (!examples.ok) warnOnce(`The examples setting is invalid, using the default examples. ${examples.error}`);
    const names = new Set(active.map(({ name }) => name));
    const candidates = examples.ok ? examples.value : DEFAULT_EXAMPLES;
    const kept = candidates.filter((example) => names.has(categoryOf(example)));
    const dropped = candidates.filter((example) => !names.has(categoryOf(example)));
    if (dropped.length > 0) {
      warnOnce(`Left out examples whose category is not in the categories setting: ${dropped.join("; ")}`);
    }
    return { categories: active, examples: kept };
  }

  async function cloudState(signal?: AbortSignal): Promise<PluginAiServiceStatus> {
    let state: PluginAiServiceStatus;
    try {
      const overview = await bb.sdk.plugins.callRpc({
        pluginId: BB_AI_PLUGIN,
        method: "overview",
        input: null,
        outputSchema: overviewSchema,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!overview.enabled) {
        state = { ready: false, message: "bb cloud is off; turn it on with `bb ai on`" };
      } else if (!overview.status.ready) {
        state = { ready: false, message: overview.status.message ?? "bb cloud is not ready" };
      } else {
        state = { ready: true };
      }
    } catch (error) {
      state = { ready: false, message: `Can't reach bb cloud: ${errorMessage(error)}` };
    }
    return state;
  }

  async function bbCloudComplete(prompt: string, signal: AbortSignal): Promise<string> {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: BB_ACCOUNT_PLUGIN,
      method: BB_ACCOUNT_FETCH,
      input: {
        target: "api",
        method: "POST",
        path: COMPLETE_PATH,
        body: { prompt },
        timeoutMs: COMPLETE_TIMEOUT_MS,
      },
      outputSchema: fetchResultSchema,
      signal,
    });
    if (result.status !== 200) {
      if (result.status === 401) throw new Error("Sign in to your bb account");
      const failure = errorBodySchema.safeParse(result.body);
      throw new Error(failure.success ? failure.data.error.message : `bb cloud answered HTTP ${result.status}`);
    }
    const reply = completeBodySchema.safeParse(result.body);
    if (!reply.success) throw new Error("bb cloud returned an invalid reply");
    return reply.data.text;
  }

  bb.experimental_aiServices.register({
    id: SERVICE_ID,
    displayName: "Short thread names (bb cloud)",
    status: () => cloudState(),
    complete: async (prompt, { signal }) => {
      // Checked on every call, so `bb ai off` stops this service at once.
      const state = await cloudState(signal);
      if (!state.ready) throw new Error(state.message);
      if (!prompt.startsWith(TITLE_PROMPT_HEAD)) return bbCloudComplete(prompt, signal);
      const reply = await bbCloudComplete(buildNamingPrompt(prompt, await namingConfig()), signal);
      return reply.toLowerCase();
    },
  });

  // bb skips the title for a first prompt under 5 words ("why is this 0?") and
  // keeps the prompt text instead, and older threads carry sentence-case
  // titles. After each finished turn, a thread whose title is not yet in the
  // "category: name" form gets its title regenerated from the prompt and the
  // agent's replies. A thread that once had the form and then got another
  // title was renamed by hand and is left alone; each thread gets at most
  // MAX_ATTEMPTS tries. Nothing happens unless this service writes titles.
  const inFlight = new Set<string>();

  async function titlesUseThisService(): Promise<boolean> {
    const services = aiServicesSchema.safeParse(await bb.sdk.system.aiServices());
    const selection = services.success ? services.data.selections["thread-title"] : undefined;
    return selection?.mode === "service" && selection.pluginId === PLUGIN_ID && selection.serviceId === SERVICE_ID;
  }

  bb.events.on("thread.idle", async ({ thread }) => {
    if (thread.archivedAt !== null || inFlight.has(thread.id)) return;
    const key = `thread:${thread.id}`;
    try {
      const stored = threadMarkSchema.safeParse(await bb.storage.kv.get(key));
      const mark = stored.success ? stored.data : { formatted: false, attempts: 0 };
      if (thread.title !== null && NAME_FORMAT.test(thread.title)) {
        if (!mark.formatted) await bb.storage.kv.set(key, { ...mark, formatted: true });
        return;
      }
      if (mark.formatted || mark.attempts >= MAX_ATTEMPTS) return;
      if (!(await titlesUseThisService())) return;
      inFlight.add(thread.id);
      await bb.storage.kv.set(key, { ...mark, attempts: mark.attempts + 1 });
      await bb.sdk.threads.experimental_regenerateTitle({ threadId: thread.id });
    } catch (error) {
      bb.log.warn(`Could not rename thread ${thread.id}: ${errorMessage(error)}`);
    } finally {
      inFlight.delete(thread.id);
    }
  });
}
