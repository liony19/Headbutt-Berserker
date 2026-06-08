const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, "db.json");
const USE_SUPABASE = process.env.USE_SUPABASE === "true";
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT) > 0 ? Number(process.env.HISTORY_LIMIT) : 100;

let supabase = null;

function getSupabaseClient() {
  if (!USE_SUPABASE) return null;
  if (supabase) return supabase;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.warn("USE_SUPABASE=true, mas SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não foram configurados. Usando db.json como fallback.");
    return null;
  }

  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    return supabase;
  } catch (error) {
    console.warn("Não foi possível carregar @supabase/supabase-js. Usando db.json como fallback.", error.message);
    return null;
  }
}

function ensureLocalDbFile() {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, `${JSON.stringify({ users: [], performanceHistory: [] }, null, 2)}\n`, "utf8");
  }
}

function readLocalDb() {
  try {
    ensureLocalDbFile();
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!Array.isArray(parsed.performanceHistory)) parsed.performanceHistory = [];
    return parsed;
  } catch (error) {
    console.error("Erro ao ler db.json:", error);
    return { users: [], performanceHistory: [] };
  }
}

function writeLocalDb(db) {
  ensureLocalDbFile();
  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

function toFiniteNumber(value, fallback = 0) {
  if (value === "INF" || value === Infinity) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeForSupabase(entry = {}) {
  return {
    user_id: entry.userId || entry.user_id || null,
    player_name: entry.playerName || entry.player_name || null,
    original_id: entry.id ? String(entry.id).slice(0, 120) : null,
    phase: toFiniteNumber(entry.phase, 1),
    custom_mode: Boolean(entry.customMode),
    difficulty_phase: toFiniteNumber(entry.difficultyPhase ?? entry.phase, 1),
    status: entry.status || "interrompida",
    lives_left: toFiniteNumber(entry.livesLeft, 0),
    enemy_hits: toFiniteNumber(entry.enemyHits, 0),
    enemy_hits_needed: toFiniteNumber(entry.enemyHitsNeeded, 0),
    hits: toFiniteNumber(entry.hits, 0),
    misses: toFiniteNumber(entry.misses, 0),
    attempts: toFiniteNumber(entry.attempts, 0),
    accuracy: toFiniteNumber(entry.accuracy, 0),
    duration: toFiniteNumber(entry.duration, 0),
    avg_reaction: entry.avgReaction == null ? null : toFiniteNumber(entry.avgReaction, null),
    actions: Array.isArray(entry.actions) ? entry.actions : [],
    action_breakdown: entry.actionBreakdown && typeof entry.actionBreakdown === "object" ? entry.actionBreakdown : {},
    raw_data: entry,
    created_at: entry.createdAt || new Date().toISOString()
  };
}

function fromSupabaseRow(row = {}) {
  const raw = row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};

  return {
    ...raw,
    id: raw.id || row.original_id || row.id,
    userId: row.user_id || raw.userId || raw.user_id || null,
    playerName: row.player_name || raw.playerName || raw.player_name || null,
    phase: row.phase ?? raw.phase,
    customMode: row.custom_mode ?? raw.customMode,
    difficultyPhase: row.difficulty_phase ?? raw.difficultyPhase,
    status: row.status ?? raw.status,
    livesLeft: row.lives_left == null && raw.livesLeft === "INF" ? "INF" : (row.lives_left ?? raw.livesLeft),
    enemyHits: row.enemy_hits ?? raw.enemyHits,
    enemyHitsNeeded: row.enemy_hits_needed == null && raw.enemyHitsNeeded === "INF" ? "INF" : (row.enemy_hits_needed ?? raw.enemyHitsNeeded),
    hits: row.hits ?? raw.hits,
    misses: row.misses ?? raw.misses,
    attempts: row.attempts ?? raw.attempts,
    accuracy: row.accuracy ?? raw.accuracy,
    duration: row.duration ?? raw.duration,
    avgReaction: row.avg_reaction ?? raw.avgReaction,
    actions: row.actions ?? raw.actions ?? [],
    actionBreakdown: row.action_breakdown ?? raw.actionBreakdown ?? {},
    createdAt: row.created_at ?? raw.createdAt
  };
}

async function getHistory(userId = null) {
  const client = getSupabaseClient();

  if (client) {
    const { data, error } = await client
      .from("performance_history")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);

    if (error) throw error;
    return (data || []).map(fromSupabaseRow);
  }

  const pool = await ensurePostgresSchema();
  if (pool) {
    const { rows } = await pool.query(
      "select * from performance_history where user_id = $1 order by created_at desc limit $2",
      [userId, HISTORY_LIMIT]
    );
    return rows.map(fromSupabaseRow);
  }

  const db = readLocalDb();
  return (db.performanceHistory || []).filter((entry) => String(entry.userId || entry.user_id || "") === String(userId || ""));
}

async function saveHistory(entry, user = null) {
  const client = getSupabaseClient();

  if (client) {
    const payload = normalizeForSupabase({
      ...entry,
      userId: user ? user.id : entry.userId,
      playerName: user ? user.displayName : entry.playerName
    });
    const { data, error } = await client
      .from("performance_history")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;
    return fromSupabaseRow(data);
  }

  const pool = await ensurePostgresSchema();
  if (pool) {
    const payload = normalizeForSupabase({
      ...entry,
      userId: user ? user.id : entry.userId,
      playerName: user ? user.displayName : entry.playerName
    });
    const { rows } = await pool.query(
      `insert into performance_history (
        user_id, player_name, original_id, phase, custom_mode, difficulty_phase, status, lives_left,
        enemy_hits, enemy_hits_needed, hits, misses, attempts, accuracy,
        duration, avg_reaction, actions, action_breakdown, raw_data, created_at
      ) values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19::jsonb, $20
      ) returning *`,
      [
        payload.user_id, payload.player_name, payload.original_id, payload.phase, payload.custom_mode, payload.difficulty_phase, payload.status, payload.lives_left,
        payload.enemy_hits, payload.enemy_hits_needed, payload.hits, payload.misses, payload.attempts, payload.accuracy,
        payload.duration, payload.avg_reaction, JSON.stringify(payload.actions), JSON.stringify(payload.action_breakdown), JSON.stringify(payload.raw_data), payload.created_at
      ]
    );
    return fromSupabaseRow(rows[0]);
  }

  const db = readLocalDb();
  const localEntry = {
    ...entry,
    userId: user ? user.id : entry.userId,
    playerName: user ? user.displayName : entry.playerName
  };
  db.performanceHistory = [localEntry, ...(db.performanceHistory || [])].filter((item, index, arr) => index < HISTORY_LIMIT || String(item.userId || "") !== String(localEntry.userId || ""));
  writeLocalDb(db);
  return localEntry;
}

async function replaceHistory(entries, user = null) {
  const client = getSupabaseClient();

  if (client) {
    const { error: deleteError } = await client
      .from("performance_history")
      .delete()
      .eq("user_id", user ? user.id : null);

    if (deleteError) throw deleteError;

    if (!entries.length) return [];

    const payload = entries.map((entry) => normalizeForSupabase({
      ...entry,
      userId: user ? user.id : entry.userId,
      playerName: user ? user.displayName : entry.playerName
    }));
    const { data, error } = await client
      .from("performance_history")
      .insert(payload)
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data || []).map(fromSupabaseRow);
  }

  const pool = await ensurePostgresSchema();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from performance_history where user_id = $1", [user ? user.id : null]);

      const savedRows = [];
      for (const entry of entries) {
        const payload = normalizeForSupabase({
          ...entry,
          userId: user ? user.id : entry.userId,
          playerName: user ? user.displayName : entry.playerName
        });
        const { rows } = await client.query(
          `insert into performance_history (
            user_id, player_name, original_id, phase, custom_mode, difficulty_phase, status, lives_left,
            enemy_hits, enemy_hits_needed, hits, misses, attempts, accuracy,
            duration, avg_reaction, actions, action_breakdown, raw_data, created_at
          ) values (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19::jsonb, $20
          ) returning *`,
          [
            payload.user_id, payload.player_name, payload.original_id, payload.phase, payload.custom_mode, payload.difficulty_phase, payload.status, payload.lives_left,
            payload.enemy_hits, payload.enemy_hits_needed, payload.hits, payload.misses, payload.attempts, payload.accuracy,
            payload.duration, payload.avg_reaction, JSON.stringify(payload.actions), JSON.stringify(payload.action_breakdown), JSON.stringify(payload.raw_data), payload.created_at
          ]
        );
        savedRows.push(rows[0]);
      }

      await client.query("commit");
      return savedRows.map(fromSupabaseRow).slice(0, HISTORY_LIMIT);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  const db = readLocalDb();
  const userId = user ? String(user.id) : "";
  const userEntries = entries.slice(0, HISTORY_LIMIT).map((entry) => ({
    ...entry,
    userId: user ? user.id : entry.userId,
    playerName: user ? user.displayName : entry.playerName
  }));
  db.performanceHistory = [
    ...userEntries,
    ...(db.performanceHistory || []).filter((entry) => String(entry.userId || "") !== userId)
  ];
  writeLocalDb(db);
  return userEntries;
}

async function getDatabaseStatus() {
  const client = getSupabaseClient();

  if (client) {
    const { error } = await client
      .from("performance_history")
      .select("id", { count: "exact", head: true });

    return {
      provider: "supabase",
      usingSupabase: true,
      connected: !error,
      error: error ? error.message : null
    };
  }

  const pool = await ensurePostgresSchema();
  if (pool) {
    try {
      await pool.query("select 1");
      return {
        provider: "postgres",
        usingPostgres: true,
        connected: true
      };
    } catch (error) {
      return {
        provider: "postgres",
        usingPostgres: true,
        connected: false,
        error: error.message
      };
    }
  }

  return {
    provider: "json",
    usingSupabase: false,
    usingPostgres: false,
    dbPath: DB_PATH
  };
}

module.exports = {
  DB_PATH,
  ensureLocalDbFile,
  authenticateUser,
  createUser,
  getUserById,
  getDatabaseStatus,
  getHistory,
  saveHistory,
  replaceHistory
};
