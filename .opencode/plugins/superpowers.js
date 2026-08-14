/**
 * Superpowers plugin for OpenCode.ai
 *
 * Dual-compatible with OpenCode V1 (`opencode`) and V2 (`opencode2`).
 *
 * V1 (opencode): loaded via the named export `SuperpowersPlugin`. Provides the
 * `config` hook to register the skills directory and
 * `experimental.chat.messages.transform` to inject bootstrap context.
 *
 * V2 (opencode2): loaded via the default export `{ id, setup }`. `setup()`
 * registers every superpowers skill via `ctx.skill.transform()` and injects
 * bootstrap context via `ctx.session.hook("context")`.
 *
 * No external dependencies — pure JavaScript runs in both V1 and V2.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Skills directory shared by V1 (config hook) and V2 (ctx.skill.transform).
const superpowersSkillsDir = path.resolve(__dirname, '../../skills');

// Simple frontmatter extraction (avoid dependency on skills-core for bootstrap)
const extractAndStripFrontmatter = (content) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content };

  const frontmatterStr = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of frontmatterStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      frontmatter[key] = value;
    }
  }

  return { frontmatter, content: body };
};

// Module-level cache for bootstrap content.
// The SKILL.md file does not change during a session, so reading + parsing it
// once eliminates redundant fs.existsSync + fs.readFileSync + regex work on
// every agent step.  See #1202 for the full analysis.
let _bootstrapCache = undefined; // undefined = not yet loaded, null = file missing

// Helper to generate bootstrap content (cached after first call)
const getBootstrapContent = () => {
  // Return cached result on subsequent calls
  if (_bootstrapCache !== undefined) return _bootstrapCache;

  // Try to load using-superpowers skill
  const skillPath = path.join(superpowersSkillsDir, 'using-superpowers', 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    _bootstrapCache = null;
    return null;
  }

  const fullContent = fs.readFileSync(skillPath, 'utf8');
  const { content } = extractAndStripFrontmatter(fullContent);

  const toolMapping = `**Tool Mapping for OpenCode:**
When skills request actions, substitute OpenCode equivalents:
- Create or update todos → \`todowrite\`
- \`Subagent (general-purpose):\` → \`task\` with \`subagent_type: "general"\`
- Invoke a skill → OpenCode's native \`skill\` tool
- Read files → \`read\`
- Create, edit, or delete files → \`apply_patch\`
- Run shell commands → \`bash\`
- Search files → \`grep\`, \`glob\`
- Fetch a URL → \`webfetch\`

Use OpenCode's native \`skill\` tool to list and load skills.`;

  _bootstrapCache = `<EXTREMELY_IMPORTANT>
You have superpowers.

**IMPORTANT: The using-superpowers skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the skill tool to load "using-superpowers" again - that would be redundant.**

${content}

${toolMapping}
</EXTREMELY_IMPORTANT>`;

  return _bootstrapCache;
};

// Enumerate every skill in the superpowers skills directory.
// Mirrors OpenCode V2's own directory-source loader: each `skills/<id>/SKILL.md`
// becomes a Skill.Info with id/name from the directory + frontmatter, and the
// frontmatter-stripped body as content.
const getSkills = () => {
  const skills = [];
  let entries;
  try {
    entries = fs.readdirSync(superpowersSkillsDir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(superpowersSkillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    let raw;
    try {
      raw = fs.readFileSync(skillPath, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, content } = extractAndStripFrontmatter(raw);
    const skill = {
      id: entry.name,
      name: frontmatter.name || entry.name,
      location: skillPath,
      content,
    };
    if (frontmatter.description) skill.description = frontmatter.description;
    skills.push(skill);
  }
  return skills;
};

/**
 * V1 Plugin Function (named export)
 *
 * Used by OpenCode V1: discovered via named export scanning.
 * Provides the config hook (skills registration) and
 * experimental.chat.messages.transform (bootstrap injection).
 */
export const SuperpowersPlugin = async ({ client, directory }) => {
  return {
    // Inject skills path into live config so OpenCode discovers superpowers skills
    // without requiring manual symlinks or config file edits.
    config: async (config) => {
      // V2 passes skills as a flat array — setup() handles V2 skill registration.
      if (Array.isArray(config.skills)) return;

      // V1: skills is { paths: [...] }
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(superpowersSkillsDir)) {
        config.skills.paths.push(superpowersSkillsDir);
      }
    },

    // Inject bootstrap into the first user message of each session.
    // Using a user message instead of a system message avoids:
    //   1. Token bloat from system messages repeated every turn (#750)
    //   2. Multiple system messages breaking Qwen and other models (#894)
    //
    // The hook fires on every agent step (not just every turn) because
    // opencode's prompt.ts reloads messages from DB each step.  Fresh message
    // arrays may need injection again, so getBootstrapContent() must not do
    // repeated disk work.
    'experimental.chat.messages.transform': async (_input, output) => {
      const bootstrap = getBootstrapContent();
      if (!bootstrap || !output.messages.length) return;
      const firstUser = output.messages.find(m => m.info.role === 'user');
      if (!firstUser || !firstUser.parts.length) return;

      // Guard: skip if first user message already contains bootstrap.
      // This prevents double injection when OpenCode passes an already
      // transformed in-memory message array through the hook again.
      if (firstUser.parts.some(p => p.type === 'text' && p.text.includes('EXTREMELY_IMPORTANT'))) return;

      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: 'text', text: bootstrap });
    }
  };
};

/**
 * V2 Setup Function (default.setup)
 *
 * Called by the V2 plugin loader with the plugin context. Registers the
 * superpowers skills natively via ctx.skill.transform(), and injects bootstrap
 * context via ctx.session.hook("context"), the V2 equivalent of V1's
 * experimental.chat.messages.transform.
 */
async function setup(ctx) {
  try {
    await ctx.skill.transform((draft) => {
      for (const skill of getSkills()) {
        draft.add(skill);
      }
    });
  } catch (err) {
    console.error('[superpowers] skill registration failed', err);
  }

  // A hook failure fails the dispatch it intercepts, so the injection is wrapped
  // defensively: superpowers must never break an otherwise healthy session.
  await ctx.session.hook('context', (event) => {
    try {
      const bootstrap = getBootstrapContent();
      if (!bootstrap || !event.messages || !event.messages.length) return;
      const firstUser = event.messages.find((m) => m.role === 'user');
      if (!firstUser || !firstUser.content || !firstUser.content.length) return;
      if (firstUser.content.some((p) => p.type === 'text' && p.text && p.text.includes('EXTREMELY_IMPORTANT'))) return;
      firstUser.content.unshift({ type: 'text', text: bootstrap });
    } catch (err) {
      console.error('[superpowers] bootstrap injection failed', err);
    }
  });
}

/**
 * Default Export: { id, server, setup }
 *
 * V2 reads the default export's id and setup.
 * V1 reads the named export SuperpowersPlugin.
 */
export default {
  id: 'superpowers',
  server: SuperpowersPlugin,
  setup,
};
