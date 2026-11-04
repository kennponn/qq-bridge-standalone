const UNKNOWN = Object.freeze({ known: false, blocked: false });
const ALLOWED = Object.freeze({ known: true, blocked: false });
const ROLES = new Set(['member', 'admin', 'owner']);

function qqId(value) {
  const text = String(value ?? '').trim();
  return /^[1-9]\d{0,19}$/.test(text) ? text : null;
}

function groupKey(value) {
  const match = /^group:([1-9]\d{0,19})$/.exec(String(value ?? ''));
  return match ? { key: match[0], id: match[1] } : null;
}

function wholeMute(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

function timestampMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER / 1000
    ? number * 1000 : null;
}

export function createGroupSendPermission({ query, now = Date.now, maxEntries = 1000 } = {}) {
  if (typeof query !== 'function' || typeof now !== 'function') throw new TypeError('query and now must be functions');
  const requestedSize = Number(maxEntries);
  const capacity = Number.isFinite(requestedSize) ? Math.max(1, Math.min(10000, Math.floor(requestedSize))) : 1000;
  const entries = new Map();

  function classify(entry, time) {
    if (!entry) return UNKNOWN;
    if (entry.individualUntil > time && entry.individualKnown) {
      return { known: true, blocked: true, blockedUntil: entry.individualUntil, reason: 'individual' };
    }
    if (!entry.memberKnown || !entry.groupKnown || !ROLES.has(entry.role)) return UNKNOWN;
    if (entry.whole && entry.role === 'member') {
      return { known: true, blocked: true, blockedUntil: null, reason: 'whole-group' };
    }
    if (!entry.individualKnown) return UNKNOWN;
    return ALLOWED;
  }

  function cacheTtl(value) {
    return !value.known || value.blocked ? 5000 : 30000;
  }

  function touch(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > capacity) entries.delete(entries.keys().next().value);
  }

  function makeEntry(key, selfId) {
    const entry = { selfId, revision: 0, expiresAt: 0, memberKnown: false, groupKnown: false,
      individualKnown: false, individualUntil: 0, role: null, whole: false, flight: null };
    touch(key, entry);
    return entry;
  }

  function current(key, selfId) {
    const old = entries.get(key);
    return old?.selfId === selfId ? old : makeEntry(key, selfId);
  }

  function peek(key) {
    const entry = entries.get(key);
    if (entry?.individualKnown && entry.individualUntil > now()) return classify(entry, now());
    if (!entry || entry.expiresAt <= now()) return UNKNOWN;
    return classify(entry, now());
  }

  async function check(key, selfId, { force = false } = {}) {
    if (/^private:[1-9]\d{0,19}$/.test(String(key ?? ''))) return ALLOWED;
    const target = groupKey(key);
    const self = qqId(selfId);
    if (!target || !self) return UNKNOWN;
    const entry = current(target.key, self);
    touch(target.key, entry);
    if (!force && entry.expiresAt > now()) return classify(entry, now());
    if (entry.flight) return entry.flight;
    const revision = entry.revision;
    const newerValue = () => entries.get(target.key)?.selfId === self ? peek(target.key) : UNKNOWN;
    const promise = Promise.resolve().then(() => query(target.id, self)).then(data => {
      // A newer notice, invalidation, account change or eviction wins over an old API reply.
      if (entries.get(target.key) !== entry || entry.revision !== revision) return newerValue();
      const member = data?.member;
      const group = data?.group;
      const reliableMember = member && typeof member === 'object' && !Array.isArray(member)
        && qqId(member.user_id) === self;
      const reliableGroup = group && typeof group === 'object' && !Array.isArray(group)
        && (group.group_id === undefined || qqId(group.group_id) === target.id)
        && wholeMute(group.group_all_shut) !== null;
      const until = timestampMs(member?.shut_up_timestamp);
      entry.memberKnown = !!reliableMember;
      entry.groupKnown = !!reliableGroup;
      entry.role = reliableMember && ROLES.has(member.role) ? member.role : null;
      entry.whole = reliableGroup ? wholeMute(group.group_all_shut) : false;
      // An individual mute belongs to this verified member, independent of the group-info query.
      if (reliableMember && until !== null) {
        entry.individualKnown = true;
        entry.individualUntil = until;
      } else if (!(entry.individualKnown && entry.individualUntil > now())) {
        entry.individualKnown = false;
        entry.individualUntil = 0;
      }
      const value = classify(entry, now());
      entry.expiresAt = now() + cacheTtl(value);
      return value;
    }).catch(() => {
      if (entries.get(target.key) !== entry || entry.revision !== revision) return newerValue();
      entry.memberKnown = false;
      entry.groupKnown = false;
      if (!(entry.individualKnown && entry.individualUntil > now())) {
        entry.individualKnown = false;
        entry.individualUntil = 0;
      }
      entry.role = null;
      entry.expiresAt = now() + 5000;
      return classify(entry, now());
    }).finally(() => { if (entry.flight === promise) entry.flight = null; });
    entry.flight = promise;
    return promise;
  }

  function notice(event) {
    if (event?.notice_type !== undefined && event.notice_type !== 'group_ban') return false;
    if (!['ban', 'lift_ban'].includes(event?.sub_type)) return false;
    const group = qqId(event?.group_id);
    const self = qqId(event?.self_id);
    const user = String(event?.user_id ?? '').trim();
    const duration = Number(event?.duration);
    if (!group || !self || (user !== '0' && user !== self)
        || (user !== '0' && (event?.duration === undefined || !Number.isSafeInteger(duration) || duration < 0
          || duration > Number.MAX_SAFE_INTEGER / 1000
          || (event.sub_type === 'lift_ban' && duration !== 0)))) return false;
    const key = 'group:' + group;
    const entry = current(key, self);
    entry.revision += 1;
    entry.flight = null;
    if (user === '0') {
      // Whole-group events use subtype; gateways disagree on their duration sentinel.
      entry.whole = event.sub_type === 'ban';
      entry.groupKnown = true;
    } else {
      entry.individualKnown = true;
      entry.individualUntil = event.sub_type === 'ban' && duration > 0 ? now() + duration * 1000 : 0;
    }
    const value = classify(entry, now());
    entry.expiresAt = value.known ? now() + cacheTtl(value) : 0;
    touch(key, entry);
    return true;
  }

  function invalidate(key) {
    return entries.delete(String(key));
  }

  return { check, peek, notice, invalidate, clear: () => entries.clear() };
}
