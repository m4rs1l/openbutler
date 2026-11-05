/**
 * The icon registry: pure data — no DOM, no CSS, no network.
 *
 * Every glyph ships inside the client bundle, so an icon never waits on a
 * request of its own. That is what removes both failure modes of the old
 * `lucide-react/dynamic` path — the blank icon while a per-icon chunk
 * downloads, and the icon that stays blank forever when that chunk 404s after
 * a rebuild. Holding the data apart from the React renderer keeps it importable
 * by any surface that renders SVG, a future Electron renderer included.
 *
 * Two families share one namespace, so a name is unique by construction (a
 * duplicated key in the literal below is a compile error):
 *
 *   - `line`  — a Lucide stroke glyph, drawn with `size` and `strokeWidth`.
 *   - `brand` — a provider's own mark from `@thesvg/react`, filled and never
 *               stroked, so it keeps its real form instead of being recolored.
 *
 * Adding a glyph means importing its PascalCase export and registering it
 * under a kebab-case name. `IconName` is derived from this object, so a typo
 * fails the build rather than quietly rendering the wrong icon.
 */
import type { ComponentType, SVGProps } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AudioLines,
  Box,
  Brain,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  CircleStop,
  Cloud,
  Code,
  Command,
  Contrast,
  Copy,
  CornerDownRight,
  Cpu,
  Ellipsis,
  Eraser,
  File,
  FileSearch,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Hexagon,
  History,
  House,
  Image,
  Info,
  KeyRound,
  Laptop,
  ListCollapse,
  ListEnd,
  Maximize,
  Maximize2,
  MessageCircle,
  MessageSquare,
  Mic,
  Minimize,
  Minimize2,
  Network,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  PanelsTopLeft,
  Plus,
  RotateCcw,
  RotateCw,
  ScrollText,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  SquareMinus,
  SquarePen,
  SquarePlus,
  SquareTerminal,
  Terminal,
  TextCursorInput,
  Trash2,
  Waypoints,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  Alibaba,
  Amd,
  Anthropic,
  Arcee,
  Aws,
  Baseten,
  Cerebras,
  Clarifai,
  Cohere,
  Crusoe,
  Databricks,
  Deepinfra,
  Deepseek,
  Digitalocean,
  Friendli,
  GithubCopilot,
  Gitlab,
  Google,
  GoogleCloud,
  Groq,
  Hetzner,
  Huggingface,
  Infomaniak,
  LmStudio,
  Longcat,
  Meta,
  MicrosoftAzure,
  Minimax,
  Mistral,
  Modal,
  Modelscope,
  Moonshot,
  Nebius,
  Nvidia,
  Ollama,
  Openai,
  Openrouter,
  Perplexity,
  Poe,
  Sambanova,
  Scaleway,
  Sensenova,
  Stepfun,
  TogetherAi,
  Upstage,
  Vercel,
  Volcengine,
  Vultr,
  Xai,
  Xiaomi,
} from '@thesvg/react';

export type LineGlyph = { readonly kind: 'line'; readonly component: LucideIcon };
export type BrandGlyph = {
  readonly kind: 'brand';
  readonly component: ComponentType<SVGProps<SVGSVGElement>>;
  /** Human name of the brand, for the title a caller may surface. */
  readonly title: string;
};
export type Glyph = LineGlyph | BrandGlyph;

const line = (component: LucideIcon): LineGlyph => ({ kind: 'line', component });
const brand = (component: BrandGlyph['component'], title: string): BrandGlyph => ({ kind: 'brand', component, title });

const glyphs = {
  'arrow-left': line(ArrowLeft),
  'arrow-right': line(ArrowRight),
  'arrow-up': line(ArrowUp),
  'audio-lines': line(AudioLines),
  box: line(Box),
  brain: line(Brain),
  'chart-no-axes-combined': line(ChartNoAxesCombined),
  check: line(Check),
  'chevron-down': line(ChevronDown),
  'chevron-left': line(ChevronLeft),
  'chevron-right': line(ChevronRight),
  'chevrons-down-up': line(ChevronsDownUp),
  'circle-stop': line(CircleStop),
  cloud: line(Cloud),
  code: line(Code),
  command: line(Command),
  contrast: line(Contrast),
  copy: line(Copy),
  'corner-down-right': line(CornerDownRight),
  cpu: line(Cpu),
  ellipsis: line(Ellipsis),
  eraser: line(Eraser),
  file: line(File),
  'file-search': line(FileSearch),
  folder: line(Folder),
  'folder-open': line(FolderOpen),
  'folder-plus': line(FolderPlus),
  globe: line(Globe),
  hexagon: line(Hexagon),
  history: line(History),
  house: line(House),
  image: line(Image),
  info: line(Info),
  'key-round': line(KeyRound),
  laptop: line(Laptop),
  'list-collapse': line(ListCollapse),
  'list-end': line(ListEnd),
  maximize: line(Maximize),
  'maximize-2': line(Maximize2),
  'message-circle': line(MessageCircle),
  'message-square': line(MessageSquare),
  mic: line(Mic),
  minimize: line(Minimize),
  'minimize-2': line(Minimize2),
  network: line(Network),
  'panel-left': line(PanelLeft),
  'panel-right': line(PanelRight),
  'panel-right-close': line(PanelRightClose),
  'panels-top-left': line(PanelsTopLeft),
  plus: line(Plus),
  'rotate-ccw': line(RotateCcw),
  'rotate-cw': line(RotateCw),
  'scroll-text': line(ScrollText),
  search: line(Search),
  send: line(Send),
  settings: line(Settings),
  'shield-check': line(ShieldCheck),
  'sliders-horizontal': line(SlidersHorizontal),
  square: line(Square),
  'square-minus': line(SquareMinus),
  'square-pen': line(SquarePen),
  'square-plus': line(SquarePlus),
  'square-terminal': line(SquareTerminal),
  terminal: line(Terminal),
  'text-cursor-input': line(TextCursorInput),
  'trash-2': line(Trash2),
  waypoints: line(Waypoints),
  x: line(X),
  zap: line(Zap),

  // Provider marks. The key is the provider id the catalog uses, so a row
  // resolves by its own id; where the brand file is named differently, the
  // id is mapped below in `providerAliases`.
  alibaba: brand(Alibaba, 'Alibaba'),
  amd: brand(Amd, 'AMD'),
  anthropic: brand(Anthropic, 'Anthropic'),
  arcee: brand(Arcee, 'Arcee'),
  'amazon-bedrock': brand(Aws, 'AWS'),
  baseten: brand(Baseten, 'Baseten'),
  cerebras: brand(Cerebras, 'Cerebras'),
  clarifai: brand(Clarifai, 'Clarifai'),
  cohere: brand(Cohere, 'Cohere'),
  crusoe: brand(Crusoe, 'Crusoe'),
  databricks: brand(Databricks, 'Databricks'),
  deepinfra: brand(Deepinfra, 'DeepInfra'),
  deepseek: brand(Deepseek, 'DeepSeek'),
  digitalocean: brand(Digitalocean, 'DigitalOcean'),
  friendli: brand(Friendli, 'Friendli AI'),
  'github-copilot': brand(GithubCopilot, 'GitHub Copilot'),
  gitlab: brand(Gitlab, 'GitLab'),
  google: brand(Google, 'Google'),
  'google-vertex': brand(GoogleCloud, 'Google Cloud'),
  groq: brand(Groq, 'Groq'),
  hetzner: brand(Hetzner, 'Hetzner'),
  huggingface: brand(Huggingface, 'Hugging Face'),
  infomaniak: brand(Infomaniak, 'Infomaniak'),
  lmstudio: brand(LmStudio, 'LM Studio'),
  longcat: brand(Longcat, 'LongCat'),
  meta: brand(Meta, 'Meta'),
  azure: brand(MicrosoftAzure, 'Microsoft Azure'),
  minimax: brand(Minimax, 'MiniMax'),
  mistral: brand(Mistral, 'Mistral'),
  modal: brand(Modal, 'Modal'),
  modelscope: brand(Modelscope, 'ModelScope'),
  moonshotai: brand(Moonshot, 'Moonshot AI'),
  nebius: brand(Nebius, 'Nebius'),
  nvidia: brand(Nvidia, 'NVIDIA'),
  'ollama-cloud': brand(Ollama, 'Ollama'),
  openai: brand(Openai, 'OpenAI'),
  openrouter: brand(Openrouter, 'OpenRouter'),
  perplexity: brand(Perplexity, 'Perplexity'),
  'perplexity-agent': brand(Perplexity, 'Perplexity'),
  poe: brand(Poe, 'Poe'),
  sambanova: brand(Sambanova, 'SambaNova'),
  scaleway: brand(Scaleway, 'Scaleway'),
  sensenova: brand(Sensenova, 'SenseNova'),
  stepfun: brand(Stepfun, 'StepFun'),
  togetherai: brand(TogetherAi, 'Together AI'),
  upstage: brand(Upstage, 'Upstage'),
  vercel: brand(Vercel, 'Vercel'),
  volcengine: brand(Volcengine, 'Volcengine'),
  vultr: brand(Vultr, 'Vultr'),
  xai: brand(Xai, 'xAI'),
  xiaomi: brand(Xiaomi, 'Xiaomi'),
} satisfies Record<string, Glyph>;

export type IconName = keyof typeof glyphs;

/** The registered glyph, or undefined when the name is not in the registry. */
export function resolveGlyph(name: string): Glyph | undefined {
  return (glyphs as Record<string, Glyph | undefined>)[name];
}

/**
 * The catalog spells the same company several ways (`lmstudio`, `moonshotai`,
 * `azure` for Bedrock's neighbour `amazon-bedrock`, and the regional and plan
 * variants of one brand). Only ids seen in the live catalog are listed here;
 * an id nobody has mapped gets no logo rather than somebody else's.
 */
const providerAliases: Record<string, IconName> = {
  'alibaba-coding-plan': 'alibaba',
  'alibaba-coding-plan-cn': 'alibaba',
  'alibaba-cn': 'alibaba',
  'alibaba-token-plan': 'alibaba',
  'alibaba-token-plan-cn': 'alibaba',
  'kimi-code-plan-cn': 'moonshotai',
  'kimi-code-plan-global': 'moonshotai',
  'minimax-cn': 'minimax',
  'volcengine-coding-plan': 'volcengine',
  'xiaomi-token-plan-ams': 'xiaomi',
  'xiaomi-token-plan-cn': 'xiaomi',
  'xiaomi-token-plan-sgp': 'xiaomi',
};

/**
 * The brand mark for a provider id, or null when the registry holds none.
 * Only brand entries qualify: a provider id that happens to read like a line
 * glyph (`cloud`, `box`) must never render as a fake logo.
 */
export function providerIconName(providerId: string): IconName | null {
  const id = providerId.trim().toLocaleLowerCase('en');
  if (resolveGlyph(id)?.kind === 'brand') return id as IconName;
  return providerAliases[id] ?? null;
}
