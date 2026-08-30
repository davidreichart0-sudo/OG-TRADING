import axios from "axios";
import { config } from "../config/index.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("social:x");

export interface SocialXReport {
  available: boolean; // false if no TWITTER_BEARER_TOKEN configured
  mentionCount15m: number;
  mentionVelocityPerMin: number;
  influencerMentions: { username: string; followers: number }[];
  botLikelihoodAvg: number; // 0-1, average across mentioning accounts
  sentimentScore: number; // -1..1, simple lexicon heuristic
}

const POSITIVE_WORDS = ["moon", "bullish", "gem", "based", "pump", "send it", "lfg", "🚀", "💎"];
const NEGATIVE_WORDS = ["rug", "scam", "dump", "avoid", "honeypot", "warning", "sell", "dead"];

/**
 * NOTE ON COST: X API v2 recent-search is a paid product. The free tier is
 * not viable for this use case (rate limits far too low for
 * seconds-scale sniping). Get a bearer token with the "recent search"
 * product at developer.x.com and set TWITTER_BEARER_TOKEN. Without it,
 * this module degrades gracefully — `available: false`, contributes 0 to
 * both risk and social scoring instead of throwing.
 */
export async function analyzeX(tokenSymbol: string, mintAddress: string): Promise<SocialXReport> {
  if (!config.social.twitterBearerToken) {
    return {
      available: false,
      mentionCount15m: 0,
      mentionVelocityPerMin: 0,
      influencerMentions: [],
      botLikelihoodAvg: 0,
      sentimentScore: 0,
    };
  }

  try {
    const query = `(${tokenSymbol} OR ${mintAddress}) -is:retweet`;
    const { data } = await axios.get("https://api.x.com/2/tweets/search/recent", {
      headers: { Authorization: `Bearer ${config.social.twitterBearerToken}` },
      params: {
        query,
        max_results: 50,
        "tweet.fields": "created_at,public_metrics,author_id",
        expansions: "author_id",
        "user.fields": "created_at,public_metrics,profile_image_url,username",
      },
      timeout: 6000,
    });

    const tweets: any[] = data.data ?? [];
    const users: any[] = data.includes?.users ?? [];
    const usersById = new Map(users.map((u) => [u.id, u]));

    const mentionCount15m = tweets.length;
    const mentionVelocityPerMin = mentionCount15m / 15;

    const influencerMentions = users
      .filter((u) => (u.public_metrics?.followers_count ?? 0) >= 10_000)
      .map((u) => ({ username: u.username, followers: u.public_metrics.followers_count }));

    let botScoreSum = 0;
    let botScoreCount = 0;
    for (const tweet of tweets) {
      const user = usersById.get(tweet.author_id);
      if (!user) continue;
      botScoreSum += estimateBotLikelihood(user);
      botScoreCount++;
    }
    const botLikelihoodAvg = botScoreCount > 0 ? botScoreSum / botScoreCount : 0;

    const sentimentScore = estimateSentiment(tweets.map((t) => t.text as string));

    return {
      available: true,
      mentionCount15m,
      mentionVelocityPerMin,
      influencerMentions,
      botLikelihoodAvg,
      sentimentScore,
    };
  } catch (err) {
    log.warn({ err: (err as Error).message, tokenSymbol }, "X analysis failed");
    return {
      available: false,
      mentionCount15m: 0,
      mentionVelocityPerMin: 0,
      influencerMentions: [],
      botLikelihoodAvg: 0,
      sentimentScore: 0,
    };
  }
}

/**
 * Transparent heuristic, NOT a trained classifier: accounts created very
 * recently, with a heavily skewed following/follower ratio, or a
 * default-looking username (word + long digit suffix) score closer to 1
 * ("likely bot"). Treat this as a rough signal to weight, not ground truth.
 */
function estimateBotLikelihood(user: any): number {
  let score = 0;
  const createdAt = user.created_at ? new Date(user.created_at) : null;
  const accountAgeDays = createdAt ? (Date.now() - createdAt.getTime()) / 86_400_000 : 9999;
  if (accountAgeDays < 30) score += 0.35;

  const followers = user.public_metrics?.followers_count ?? 0;
  const following = user.public_metrics?.following_count ?? 0;
  if (following > 0 && followers / following < 0.05) score += 0.35;

  if (/^[a-zA-Z_]+\d{4,}$/.test(user.username ?? "")) score += 0.2;
  if (!user.profile_image_url || user.profile_image_url.includes("default_profile")) score += 0.1;

  return Math.min(score, 1);
}

/** Simple lexicon-based sentiment — counts positive vs. negative keyword
 * hits. This will not catch sarcasm or nuance; it exists to give a cheap,
 * explainable directional signal alongside the other inputs, not to
 * function as real NLP sentiment analysis. */
function estimateSentiment(texts: string[]): number {
  if (texts.length === 0) return 0;
  let pos = 0;
  let neg = 0;
  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const w of POSITIVE_WORDS) if (lower.includes(w)) pos++;
    for (const w of NEGATIVE_WORDS) if (lower.includes(w)) neg++;
  }
  const total = pos + neg;
  return total === 0 ? 0 : (pos - neg) / total;
}
