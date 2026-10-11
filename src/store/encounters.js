/**
 * “遇见”存档层。这里不依赖 UI 或 AI：预选不写入存档，真正开始时才由
 * commitMatch 一次性占用当日名额并创建一个不可续接的新场次。
 */
import { FRIEND } from '../config.js';
import { PERSONAS, ageOf, genderOf } from '../data/personas.js';
import { isFriend } from './friends.js';

export const ENCOUNTER_DAILY_LIMIT = 5;
export const ENCOUNTER_COOLDOWN_MS = 48 * 60 * 60 * 1000;
export const ENCOUNTER_MIN_AGE = 18;
export const ENCOUNTER_MAX_AGE = 55;
export const ENCOUNTER_CENTER_MIN = 20;
export const ENCOUNTER_CENTER_MAX = 53;
export const ENCOUNTER_UNLOCK_TOTAL = 10;
export const ENCOUNTER_UNLOCK_PLAYER = 4;

const dateKey = (at = Date.now()) => {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export { dateKey as encounterDateKey };

export function defaultEncounters() {
  return { days: {}, records: {}, recent: [] };
}

/** Repair legacy or manually edited saves without throwing away their history. */
export function ensureEncounters(save) {
  if (!save || typeof save !== 'object') return defaultEncounters();
  const raw = save.encounters;
  const base = defaultEncounters();
  const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : base;
  save.encounters = store;
  if (!store.days || typeof store.days !== 'object' || Array.isArray(store.days)) store.days = {};
  if (!store.records || typeof store.records !== 'object' || Array.isArray(store.records)) store.records = {};
  if (!Array.isArray(store.recent)) store.recent = [];
  for (const [day, value] of Object.entries(store.days)) {
    if (!value || typeof value !== 'object') store.days[day] = { used: 0 };
    else value.used = Math.max(0, Math.floor(Number(value.used) || 0));
  }
  for (const [personaId, value] of Object.entries(store.records)) {
    const record = value && typeof value === 'object' ? value : {};
    store.records[personaId] = record;
    record.personaId = personaId;
    if (!Array.isArray(record.sessions)) record.sessions = [];
    record.encounterCount = Math.max(record.sessions.length, Math.floor(Number(record.encounterCount) || 0));
    record.sessions.forEach((session, i) => {
      if (!session || typeof session !== 'object') record.sessions[i] = {};
      const s = record.sessions[i];
      s.id = String(s.id || `${personaId}-${s.number || i + 1}`);
      s.number = Math.max(1, Math.floor(Number(s.number) || i + 1));
      s.startedAt = Number.isFinite(Number(s.startedAt)) ? Number(s.startedAt) : 0;
      s.endedAt = Number.isFinite(Number(s.endedAt)) ? Number(s.endedAt) : null;
      s.status = s.status === 'active' && !s.endedAt ? 'active' : 'ended';
      if (!Array.isArray(s.messages)) s.messages = [];
    });
  }
  store.recent = store.recent
    .filter((r) => r && typeof r.personaId === 'string' && Number.isFinite(Number(r.at)))
    .map((r) => ({ personaId: r.personaId, at: Number(r.at) }));
  return store;
}

function candidatesFor(save, personas, center, gender, now) {
  const encounters = ensureEncounters(save);
  const today = dateKey(now);
  return (Array.isArray(personas) ? personas : PERSONAS).filter((persona) => {
    if (!persona || !persona.id || isFriend(save, persona.id)) return false;
    if (gender !== 'any' && genderOf(persona) !== gender) return false;
    return !encounters.recent.some((entry) => entry.personaId === persona.id
      && (dateKey(entry.at) === today || now - entry.at < ENCOUNTER_COOLDOWN_MS));
  }).map((persona) => ({ persona, age: ageOf(persona), center }));
}

function choose(list, rnd) {
  if (!list.length) return null;
  const n = Number(rnd());
  const index = Math.min(list.length - 1, Math.max(0, Math.floor((Number.isFinite(n) ? n : 0) * list.length)));
  return list[index];
}

/**
 * Pick an offer, without using a quota or adding a session. `offer` can be passed
 * directly to commitMatch; it receives an in-memory consumed flag after success.
 */
export function previewMatch(save, {
  personas = PERSONAS, center = 26, gender = 'any', now = Date.now(), rnd = Math.random,
} = {}) {
  const normalizedCenter = Math.max(ENCOUNTER_CENTER_MIN, Math.min(ENCOUNTER_CENTER_MAX, Math.round(Number(center) || 26)));
  const normalizedGender = gender === 'm' || gender === 'f' ? gender : 'any';
  const windowMin = Math.max(ENCOUNTER_MIN_AGE, normalizedCenter - 2);
  const windowMax = Math.min(ENCOUNTER_MAX_AGE, normalizedCenter + 2);
  const pool = candidatesFor(save, personas, normalizedCenter, normalizedGender, now);
  const exact = pool.filter(({ age }) => age >= windowMin && age <= windowMax);
  if (exact.length) {
    const chosen = choose(exact, rnd);
    return { ok: true, persona: chosen.persona, fallback: false, distance: 0, center: normalizedCenter, gender: normalizedGender };
  }
  if (!pool.length) return { ok: false, reason: 'no-match' };
  const distances = pool.map((item) => ({ ...item, distance: item.age < windowMin ? windowMin - item.age : item.age - windowMax }));
  const minDistance = Math.min(...distances.map((item) => item.distance));
  if (minDistance > 5) return { ok: false, reason: 'no-match' };
  const chosen = choose(distances.filter((item) => item.distance === minDistance), rnd);
  return { ok: true, persona: chosen.persona, fallback: true, distance: minDistance, center: normalizedCenter, gender: normalizedGender };
}

export const selectEncounter = previewMatch;

function recordOf(save, personaId) {
  const encounters = ensureEncounters(save);
  if (!encounters.records[personaId]) encounters.records[personaId] = { personaId, encounterCount: 0, sessions: [] };
  return encounters.records[personaId];
}

/** Atomically confirms an offered persona. A consumed offer cannot be committed twice. */
export function commitMatch(save, offer, {
  personas = PERSONAS, now = Date.now(), rnd = Math.random,
} = {}) {
  if (!offer || !offer.ok || !offer.persona || offer._committed) return { ok: false, reason: 'invalid-offer' };
  const encounters = ensureEncounters(save);
  const day = dateKey(now);
  const daily = encounters.days[day] || (encounters.days[day] = { used: 0 });
  if (daily.used >= ENCOUNTER_DAILY_LIMIT) return { ok: false, reason: 'daily-limit' };
  // Re-check constraints at commit time, but do not re-roll a tie: the card the
  // player accepted remains valid even if its original preview used another rnd.
  const center = Math.max(ENCOUNTER_CENTER_MIN, Math.min(ENCOUNTER_CENTER_MAX, Math.round(Number(offer.center) || 26)));
  const gender = offer.gender === 'm' || offer.gender === 'f' ? offer.gender : 'any';
  const windowMin = Math.max(ENCOUNTER_MIN_AGE, center - 2);
  const windowMax = Math.min(ENCOUNTER_MAX_AGE, center + 2);
  const pool = candidatesFor(save, personas, center, gender, now);
  const selected = pool.find((item) => item.persona.id === offer.persona.id);
  const exact = pool.filter((item) => item.age >= windowMin && item.age <= windowMax);
  const selectedDistance = selected && (selected.age < windowMin ? windowMin - selected.age : selected.age - windowMax);
  const nearestDistance = pool.length ? Math.min(...pool.map((item) => item.age < windowMin ? windowMin - item.age : item.age - windowMax)) : Infinity;
  if (!selected || (exact.length ? !exact.includes(selected) : selectedDistance !== nearestDistance || nearestDistance > 5)) {
    return { ok: false, reason: 'stale-offer' };
  }
  const record = recordOf(save, offer.persona.id);
  const number = record.encounterCount + 1;
  const session = {
    id: `encounter-${offer.persona.id}-${number}-${now}`,
    number,
    startedAt: now,
    endedAt: null,
    status: 'active',
    messages: [],
  };
  record.encounterCount = number;
  record.sessions.push(session);
  daily.used += 1;
  encounters.recent.push({ personaId: offer.persona.id, at: now });
  offer._committed = true;
  return { ok: true, persona: offer.persona, session, record, used: daily.used };
}

export function markEnded(save, personaId, sessionId, at = Date.now()) {
  const session = findSession(save, personaId, sessionId);
  if (!session) return null;
  session.status = 'ended';
  session.endedAt = Number(at) || Date.now();
  return session;
}

export function findSession(save, personaId, sessionId) {
  const record = ensureEncounters(save).records[personaId];
  if (!record) return null;
  return record.sessions.find((session) => session && session.id === sessionId) || null;
}

export function appendEncounterMessage(save, personaId, sessionId, role, text, { at = Date.now() } = {}) {
  const session = findSession(save, personaId, sessionId);
  if (!session || session.status !== 'active') return null;
  const content = String(text == null ? '' : text).trim();
  if (!content || role === 'sys' || role === 'system') return session;
  const previous = session.messages[session.messages.length - 1];
  if (previous && previous.role === role && previous.text === content) return session;
  session.messages.push({ role, text: content, at: Number(at) || Date.now() });
  return session;
}

export function encounterProgress(session) {
  const valid = (session && Array.isArray(session.messages) ? session.messages : []).filter((message, index, list) => {
    const text = String(message && message.text || '').trim();
    if (!text || message.role === 'sys' || message.role === 'system') return false;
    const previous = list[index - 1];
    return !(previous && previous.role === message.role && String(previous.text || '').trim() === text);
  });
  const player = valid.filter((message) => message.role === 'me' || message.role === 'player').length;
  return { total: valid.length, player, unlocked: valid.length >= ENCOUNTER_UNLOCK_TOTAL && player >= ENCOUNTER_UNLOCK_PLAYER };
}

export function listEncounterHistory(save, personaId = '') {
  const records = ensureEncounters(save).records;
  if (personaId) return ((records[personaId] && records[personaId].sessions) || []).slice().sort((a, b) => a.number - b.number);
  return Object.values(records).flatMap((record) => record.sessions || []).sort((a, b) => b.startedAt - a.startedAt);
}

export function lastEncounterSummary(save, personaId) {
  const sessions = listEncounterHistory(save, personaId);
  const session = sessions[sessions.length - 1] || null;
  return session ? { session, progress: encounterProgress(session), ended: session.status === 'ended' } : null;
}

/** Move each historical encounter only once when its persona becomes a friend. */
export function migrateEncounterToFriend(save, personaId, friend) {
  const record = ensureEncounters(save).records[personaId];
  if (!record || !friend || typeof friend !== 'object') return { ok: false, migrated: 0 };
  if (!Array.isArray(friend.chat)) friend.chat = [];
  if (!Array.isArray(friend.memory)) friend.memory = [];
  if (!friend.encounterMigrated || typeof friend.encounterMigrated !== 'object') friend.encounterMigrated = {};
  let migrated = 0;
  for (const session of record.sessions.slice().sort((a, b) => a.number - b.number)) {
    if (friend.encounterMigrated[session.id]) continue;
    const at = Number(session.startedAt) || Date.now();
    friend.chat.push({ role: 'sys', text: `你们第 ${session.number} 次通过「遇见」相识`, at });
    for (const message of (session.messages || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0))) {
      friend.chat.push({ role: message.role, text: message.text, at: Number(message.at) || at });
    }
    friend.encounterMigrated[session.id] = true;
    migrated += 1;
  }
  if (migrated) {
    const at = Date.now();
    friend.chat.push({ role: 'sys', text: '你们通过「遇见」认识，并成为了好友。', at });
    if (!friend.memory.some((line) => String(line).includes('通过「遇见」认识'))) friend.memory.push('关系：你们通过「遇见」认识，并成为了好友。');
    if (friend.chat.length > FRIEND.maxHistory) friend.chat.splice(0, friend.chat.length - FRIEND.maxHistory);
  }
  return { ok: true, migrated, friend };
}
