#!/usr/bin/env node
/**
 * Crypto Market MCP Server
 * Предоставляет актуальные данные по крипторынку и традиционным финансам
 * без необходимости в API-ключах (использует бесплатные публичные эндпоинты).
 *
 * Источники данных:
 *  - CoinGecko public API (цены, капитализация, тренды)
 *  - alternative.me (Crypto Fear & Greed Index)
 *  - Yahoo Finance query endpoint (индексы, доходность облигаций, DXY)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const FEAR_GREED_URL = "https://api.alternative.me/fng/";
const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";

// -------------------- Вспомогательные функции --------------------

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "crypto-market-mcp/1.0",
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Request failed ${res.status} ${res.statusText}: ${url}\n${body.slice(0, 300)}`);
  }
  return res.json();
}

function formatNumber(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(digits) + "T";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(digits) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(digits) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(digits) + "K";
  return n.toFixed(digits);
}

// -------------------- Реализация инструментов --------------------

async function getGlobalMarketData() {
  const data = await fetchJson(`${COINGECKO_BASE}/global`);
  const d = data.data;
  return {
    total_market_cap_usd: d.total_market_cap.usd,
    total_market_cap_fmt: "$" + formatNumber(d.total_market_cap.usd),
    total_volume_24h_usd: d.total_volume.usd,
    total_volume_24h_fmt: "$" + formatNumber(d.total_volume.usd),
    market_cap_change_24h_pct: d.market_cap_change_percentage_24h_usd,
    btc_dominance_pct: d.market_cap_percentage.btc,
    eth_dominance_pct: d.market_cap_percentage.eth,
    active_cryptocurrencies: d.active_cryptocurrencies,
    markets: d.markets,
    updated_at: new Date(d.updated_at * 1000).toISOString(),
  };
}

async function getTopCoins({ limit = 20, vs_currency = "usd" }) {
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=${vs_currency}&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false&price_change_percentage=24h,7d`;
  const data = await fetchJson(url);
  return data.map((c) => ({
    rank: c.market_cap_rank,
    id: c.id,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    price_usd: c.current_price,
    market_cap_usd: c.market_cap,
    market_cap_fmt: "$" + formatNumber(c.market_cap),
    volume_24h_fmt: "$" + formatNumber(c.total_volume),
    change_24h_pct: c.price_change_percentage_24h_in_currency,
    change_7d_pct: c.price_change_percentage_7d_in_currency,
    ath: c.ath,
    ath_change_pct: c.ath_change_percentage,
  }));
}

async function getCoinDetails({ id }) {
  const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(
    id
  )}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false&sparkline=false`;
  const c = await fetchJson(url);
  return {
    id: c.id,
    symbol: c.symbol?.toUpperCase(),
    name: c.name,
    categories: c.categories,
    description_en: c.description?.en?.slice(0, 600),
    homepage: c.links?.homepage?.[0],
    twitter: c.links?.twitter_screen_name,
    price_usd: c.market_data?.current_price?.usd,
    market_cap_usd: c.market_data?.market_cap?.usd,
    market_cap_rank: c.market_data?.market_cap_rank,
    change_24h_pct: c.market_data?.price_change_percentage_24h,
    change_7d_pct: c.market_data?.price_change_percentage_7d,
    change_30d_pct: c.market_data?.price_change_percentage_30d,
    ath_usd: c.market_data?.ath?.usd,
    ath_change_pct: c.market_data?.ath_change_percentage?.usd,
    circulating_supply: c.market_data?.circulating_supply,
    total_supply: c.market_data?.total_supply,
    twitter_followers: c.community_data?.twitter_followers,
  };
}

async function searchCoin({ query }) {
  const data = await fetchJson(
    `${COINGECKO_BASE}/search?query=${encodeURIComponent(query)}`
  );
  return {
    coins: (data.coins || []).slice(0, 10).map((c) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      market_cap_rank: c.market_cap_rank,
    })),
  };
}

async function getTrendingCoins() {
  const data = await fetchJson(`${COINGECKO_BASE}/search/trending`);
  return {
    coins: (data.coins || []).map((c) => ({
      id: c.item.id,
      symbol: c.item.symbol,
      name: c.item.name,
      market_cap_rank: c.item.market_cap_rank,
      price_btc: c.item.price_btc,
    })),
    nfts: (data.nfts || []).map((n) => ({ name: n.name, symbol: n.symbol })),
  };
}

async function getFearGreedIndex({ limit = 1 }) {
  const data = await fetchJson(`${FEAR_GREED_URL}?limit=${limit}`);
  return data.data.map((d) => ({
    value: Number(d.value),
    classification: d.value_classification,
    timestamp: new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10),
  }));
}

async function getMarketMovers({ limit = 10, vs_currency = "usd" }) {
  // CoinGecko не даёт прямого "movers" эндпоинта без ключа,
  // поэтому берём топ-250 по капитализации и сортируем сами.
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=${vs_currency}&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h`;
  const data = await fetchJson(url);
  const valid = data.filter(
    (c) => typeof c.price_change_percentage_24h_in_currency === "number"
  );
  const sorted = [...valid].sort(
    (a, b) =>
      b.price_change_percentage_24h_in_currency -
      a.price_change_percentage_24h_in_currency
  );
  const gainers = sorted.slice(0, limit).map(mapMover);
  const losers = sorted.slice(-limit).reverse().map(mapMover);
  return { gainers, losers };

  function mapMover(c) {
    return {
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      price_usd: c.current_price,
      change_24h_pct: c.price_change_percentage_24h_in_currency,
      market_cap_fmt: "$" + formatNumber(c.market_cap),
    };
  }
}

async function getTraditionalMarkets() {
  // Основные индексы, доходность 10-летних облигаций США, индекс доллара
  const symbols = ["^GSPC", "^IXIC", "^DJI", "^TNX", "DX-Y.NYB", "GC=F", "CL=F"];
  const labels = {
    "^GSPC": "S&P 500",
    "^IXIC": "Nasdaq Composite",
    "^DJI": "Dow Jones",
    "^TNX": "US 10Y Treasury Yield",
    "DX-Y.NYB": "US Dollar Index (DXY)",
    "GC=F": "Gold Futures",
    "CL=F": "Crude Oil (WTI) Futures",
  };
  const url = `${YAHOO_QUOTE_URL}?symbols=${symbols
    .map(encodeURIComponent)
    .join(",")}`;
  const data = await fetchJson(url, {
    headers: { "User-Agent": "Mozilla/5.0 crypto-market-mcp" },
  });
  const results = data.quoteResponse?.result || [];
  return results.map((r) => ({
    symbol: r.symbol,
    name: labels[r.symbol] || r.shortName || r.symbol,
    price: r.regularMarketPrice,
    change_pct: r.regularMarketChangePercent,
    change: r.regularMarketChange,
    updated_at: r.regularMarketTime
      ? new Date(r.regularMarketTime * 1000).toISOString()
      : null,
  }));
}

// -------------------- Определение MCP-сервера --------------------

const TOOLS = [
  {
    name: "get_global_market_data",
    description:
      "Общая картина крипторынка: суммарная капитализация, объём торгов за 24ч, доминация BTC/ETH, число активных монет. Хорошая отправная точка для анализа рынка.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_top_coins",
    description:
      "Топ криптовалют по капитализации с ценами, изменениями за 24ч/7д, объёмами. Используй для обзора рынка и поиска тем для контента.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Сколько монет вернуть (по умолчанию 20, максимум 250)",
        },
        vs_currency: {
          type: "string",
          description: "Валюта котировки, по умолчанию usd",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_coin_details",
    description:
      "Подробные данные по одной монете: цена, капитализация, изменения, ATH, supply, соцсети. id берётся из CoinGecko (например 'bitcoin', 'ethereum', 'solana').",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "CoinGecko id монеты, напр. 'bitcoin'" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_coin",
    description:
      "Поиск монеты по названию/тикеру, чтобы найти корректный CoinGecko id для get_coin_details.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Название или тикер монеты" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_trending_coins",
    description:
      "Монеты, которые сейчас наиболее активно ищут пользователи CoinGecko — сигнал для быстрого реагирования в контенте.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_fear_greed_index",
    description:
      "Индекс страха и жадности крипторынка (0-100). Полезен как контекст/хук для статей и тредов о настроениях рынка.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Сколько последних дней вернуть, по умолчанию 1",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_market_movers",
    description:
      "Топ растущих и падающих монет за 24ч среди топ-250 по капитализации. Хорошо для быстрых новостных тредов.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Сколько монет в каждой группе, по умолчанию 10" },
        vs_currency: { type: "string", description: "Валюта котировки, по умолчанию usd" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_traditional_markets",
    description:
      "Данные традиционных финансовых рынков: S&P 500, Nasdaq, Dow Jones, доходность 10-летних гособлигаций США, индекс доллара (DXY), золото и нефть. Полезно для макро-контекста в аналитике и статьях про связь крипты и традиционных рынков.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const server = new Server(
  { name: "crypto-market-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    switch (name) {
      case "get_global_market_data":
        result = await getGlobalMarketData();
        break;
      case "get_top_coins":
        result = await getTopCoins(args);
        break;
      case "get_coin_details":
        result = await getCoinDetails(args);
        break;
      case "search_coin":
        result = await searchCoin(args);
        break;
      case "get_trending_coins":
        result = await getTrendingCoins();
        break;
      case "get_fear_greed_index":
        result = await getFearGreedIndex(args);
        break;
      case "get_market_movers":
        result = await getMarketMovers(args);
        break;
      case "get_traditional_markets":
        result = await getTraditionalMarkets();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
