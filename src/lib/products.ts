import { type ProviderId } from "./spendProviders";
import { type Subscription } from "./subscriptions";

export type ProductId =
  | "anthropic:claude-ai"
  | "anthropic:claude-code"
  | "anthropic:api"
  | "openai:chatgpt"
  | "openai:codex"
  | "openai:api"
  | "gcp:gemini-advanced"
  | "gcp:google-cloud"
  | "gcp:ai-studio"
  | "openrouter:api"
  | "groq:api";

export interface ProductDefinition {
  id: ProductId;
  providerId: ProviderId;
  label: string;
  description?: string;
}

export type ProductVisibilityState = Record<ProductId, boolean>;

interface ProductMatchRule {
  productId: ProductId;
  field: "name" | "provider";
  keywords: string[];
  excludeKeywords?: string[];
}

interface ProductBundleRule {
  providerId: ProviderId;
  keywords: string[];
  productIds: ProductId[];
  excludeKeywords?: string[];
}

export const PRODUCT_CATALOG: ProductDefinition[] = [
  {
    id: "anthropic:claude-ai",
    providerId: "anthropic",
    label: "Claude.ai",
    description: "Chat workspace and web app",
  },
  {
    id: "anthropic:claude-code",
    providerId: "anthropic",
    label: "Claude Code",
    description: "CLI and editor coding assistant",
  },
  {
    id: "anthropic:api",
    providerId: "anthropic",
    label: "API",
    description: "Direct Anthropic API usage",
  },
  {
    id: "openai:chatgpt",
    providerId: "openai",
    label: "ChatGPT",
    description: "ChatGPT Plus or Pro",
  },
  {
    id: "openai:codex",
    providerId: "openai",
    label: "Codex",
    description: "CLI and coding workflows",
  },
  {
    id: "openai:api",
    providerId: "openai",
    label: "API",
    description: "Direct OpenAI API usage",
  },
  {
    id: "gcp:gemini-advanced",
    providerId: "gcp",
    label: "Gemini Advanced",
    description: "Gemini chat and Google One AI tier",
  },
  {
    id: "gcp:google-cloud",
    providerId: "gcp",
    label: "Google Cloud",
    description: "Vertex, BigQuery, or GCP billing",
  },
  {
    id: "gcp:ai-studio",
    providerId: "gcp",
    label: "AI Studio",
    description: "Google AI Studio projects",
  },
  {
    id: "openrouter:api",
    providerId: "openrouter",
    label: "API",
    description: "Router credits and API usage",
  },
  {
    id: "groq:api",
    providerId: "groq",
    label: "API",
    description: "Groq API usage",
  },
];

const PRODUCT_LOOKUP = new Map(PRODUCT_CATALOG.map((product) => [product.id, product]));

const PRODUCTS_BY_PROVIDER = PRODUCT_CATALOG.reduce<Record<ProviderId, ProductDefinition[]>>(
  (groups, product) => {
    groups[product.providerId].push(product);
    return groups;
  },
  {
    anthropic: [],
    openai: [],
    openrouter: [],
    groq: [],
    gcp: [],
  },
);

const PRODUCT_MATCH_RULES: ProductMatchRule[] = [
  {
    productId: "anthropic:claude-ai",
    field: "name",
    keywords: ["claude pro", "claude max", "claude.ai", "claude ai", "claude"],
    excludeKeywords: ["code", "api"],
  },
  {
    productId: "anthropic:claude-code",
    field: "name",
    keywords: ["claude code"],
  },
  {
    productId: "anthropic:api",
    field: "name",
    keywords: ["anthropic api", "claude api"],
  },
  {
    productId: "openai:chatgpt",
    field: "name",
    keywords: ["chatgpt plus", "chatgpt pro", "chat gpt", "chatgpt"],
    excludeKeywords: ["codex", "api"],
  },
  {
    productId: "openai:codex",
    field: "name",
    keywords: ["openai codex", "codex"],
  },
  {
    productId: "openai:api",
    field: "name",
    keywords: ["openai api"],
  },
  {
    productId: "gcp:gemini-advanced",
    field: "name",
    keywords: ["gemini advanced", "google one ai premium", "gemini"],
    excludeKeywords: ["gcp", "cloud", "vertex"],
  },
  {
    productId: "gcp:google-cloud",
    field: "name",
    keywords: ["google cloud", "bigquery", "vertex", "gcp"],
  },
  {
    productId: "gcp:google-cloud",
    field: "provider",
    keywords: ["gcp"],
  },
  {
    productId: "gcp:ai-studio",
    field: "name",
    keywords: ["google ai studio", "ai studio"],
  },
  {
    productId: "openrouter:api",
    field: "provider",
    keywords: ["openrouter"],
  },
  {
    productId: "groq:api",
    field: "provider",
    keywords: ["groq"],
  },
];

const PRODUCT_BUNDLE_RULES: ProductBundleRule[] = [
  {
    providerId: "anthropic",
    keywords: ["claude pro", "claude max"],
    productIds: ["anthropic:claude-ai", "anthropic:claude-code"],
  },
  {
    providerId: "openai",
    keywords: ["chatgpt plus", "chatgpt pro"],
    productIds: ["openai:chatgpt", "openai:codex"],
  },
];

export function createDefaultProductVisibility(): ProductVisibilityState {
  return Object.fromEntries(PRODUCT_CATALOG.map(({ id }) => [id, true])) as ProductVisibilityState;
}

export function mergeProductVisibility(
  overrides: Partial<ProductVisibilityState>,
): ProductVisibilityState {
  return {
    ...createDefaultProductVisibility(),
    ...overrides,
  };
}

export function getProductById(productId: ProductId): ProductDefinition {
  const product = PRODUCT_LOOKUP.get(productId);
  if (!product) {
    throw new Error(`Unknown product catalog entry: ${productId}`);
  }

  return product;
}

export function getProductsForProvider(providerId: ProviderId): ProductDefinition[] {
  return PRODUCTS_BY_PROVIDER[providerId];
}

export function isProductEnabled(
  productId: ProductId,
  visibility: ProductVisibilityState,
): boolean {
  return visibility[productId] ?? true;
}

export function inferProductIds(
  subscription: Pick<Subscription, "name" | "provider">,
  providerId: ProviderId,
): ProductId[] {
  const products = getProductsForProvider(providerId);
  if (products.length === 1) {
    return [products[0].id];
  }

  const normalizedName = normalizeValue(subscription.name);
  const normalizedProvider = normalizeValue(subscription.provider);
  const matchedProductIds = new Set<ProductId>();

  PRODUCT_BUNDLE_RULES.filter((rule) => rule.providerId === providerId).forEach((rule) => {
    if (matchesRule(normalizedName, rule.keywords, rule.excludeKeywords)) {
      rule.productIds.forEach((productId) => matchedProductIds.add(productId));
    }
  });

  const nameMatches = PRODUCT_MATCH_RULES.filter(
    (rule) =>
      getProductById(rule.productId).providerId === providerId &&
      rule.field === "name" &&
      matchesRule(normalizedName, rule.keywords, rule.excludeKeywords),
  ).sort((left, right) => getRuleSpecificity(right.keywords) - getRuleSpecificity(left.keywords));

  nameMatches.forEach((rule) => matchedProductIds.add(rule.productId));

  if (matchedProductIds.size > 0) {
    return products
      .map((product) => product.id)
      .filter((productId): productId is ProductId => matchedProductIds.has(productId));
  }

  PRODUCT_MATCH_RULES.filter(
    (rule) =>
      getProductById(rule.productId).providerId === providerId &&
      rule.field === "provider" &&
      matchesRule(normalizedProvider, rule.keywords, rule.excludeKeywords),
  )
    .sort((left, right) => getRuleSpecificity(right.keywords) - getRuleSpecificity(left.keywords))
    .forEach((rule) => matchedProductIds.add(rule.productId));

  return products
    .map((product) => product.id)
    .filter((productId): productId is ProductId => matchedProductIds.has(productId));
}

function getRuleSpecificity(keywords: string[]): number {
  return Math.max(...keywords.map((keyword) => normalizeValue(keyword).length));
}

function matchesRule(
  normalizedValue: string,
  keywords: string[],
  excludeKeywords?: string[],
): boolean {
  if (normalizedValue === "") {
    return false;
  }

  if (
    excludeKeywords?.some((keyword) => containsKeyword(normalizedValue, normalizeValue(keyword)))
  ) {
    return false;
  }

  return keywords.some((keyword) => containsKeyword(normalizedValue, normalizeValue(keyword)));
}

function normalizeValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsKeyword(normalizedValue: string, normalizedKeyword: string): boolean {
  if (normalizedKeyword === "") {
    return false;
  }

  const pattern = new RegExp(`(?:^| )${escapeRegExp(normalizedKeyword)}(?:$| )`);
  return pattern.test(normalizedValue);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
