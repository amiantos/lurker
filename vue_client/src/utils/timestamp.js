const TOKEN_RE = /YYYY|MM|DD|HH|mm|ss/g;

export function formatTimestamp(iso, fmt) {
  if (!iso || !fmt) return '';
  const d = new Date(iso);
  const tokens = {
    YYYY: String(d.getFullYear()),
    MM: String(d.getMonth() + 1).padStart(2, '0'),
    DD: String(d.getDate()).padStart(2, '0'),
    HH: String(d.getHours()).padStart(2, '0'),
    mm: String(d.getMinutes()).padStart(2, '0'),
    ss: String(d.getSeconds()).padStart(2, '0'),
  };
  return fmt.replace(TOKEN_RE, (t) => tokens[t]);
}

// Format an interval between two ISO timestamps for the back-from-away
// divider ("back (gone 1h 23m)"). Sub-minute durations round up to "1m"
// instead of showing "0m" since the divider would otherwise look broken on
// a fast away/back toggle.
export function formatDuration(fromIso, toIso) {
  if (!fromIso || !toIso) return '';
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return '';
  const totalMin = Math.max(1, Math.round((toMs - fromMs) / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}
