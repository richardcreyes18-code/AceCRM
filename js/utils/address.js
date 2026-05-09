// utils/address.js — address parsing + normalization (pure, no I/O).
// Currently duplicated in the legacy <script> in index.html (lines ~3367,
// 3414, 3436, 4399); duplicates removed once consumers migrate.
// googleGeocodeAddress() lives in geocoding/google.js (Phase 5+).

// Order matters — highway-alias substitution runs BEFORE punctuation
// stripping (so "NJ-77" → "hwy 77" works); ordinals + word-numbers run
// before punctuation stripping (so "1st" / "first" both → "1").
//
// Highway aliases only fire when followed by a 1-3 digit route number
// at a word boundary, so "Elmer, NJ 08318" (state + 5-digit zip) keeps
// "nj" — not converted to "hwy 08318".
export function _normalizeAddr(s){
  if(!s) return '';
  let n = String(s).toLowerCase();
  // Fancy unicode dashes → simple hyphen
  n = n.replace(/[\u2013\u2014]/g, '-');
  // Multi-word highway aliases first ("New Jersey 77" → "hwy 77")
  n = n.replace(/\bnew\s+jersey[\s\-]*(\d{1,3})\b/g, 'hwy $1');
  // Single-token highway aliases (NJ / US / RT / Hwy / I / Route / Interstate)
  // Only fires when followed by a 1-3 digit route number, which keeps
  // "Elmer NJ 08318" (state + zip) untouched.
  n = n.replace(/\b(?:nj|n\.j\.|us|u\.s\.|rt|rte|route|hwy|highway|interstate|i)[\s\-]*(\d{1,3})\b/g, 'hwy $1');
  // Word numbers → digits (street ordinals like "1st Avenue" / "first ave")
  const wordNums = {
    first:'1', second:'2', third:'3', fourth:'4', fifth:'5', sixth:'6',
    seventh:'7', eighth:'8', ninth:'9', tenth:'10',
    eleventh:'11', twelfth:'12', thirteenth:'13', fourteenth:'14',
    fifteenth:'15', sixteenth:'16', seventeenth:'17', eighteenth:'18',
    nineteenth:'19', twentieth:'20', thirtieth:'30', fortieth:'40',
    fiftieth:'50', sixtieth:'60', seventieth:'70', eightieth:'80',
    ninetieth:'90', hundredth:'100',
  };
  n = n.replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth)\b/g, m => wordNums[m] || m);
  // Ordinal suffixes "1st" → "1", "21st" → "21", "23rd" → "23"
  n = n.replace(/(\d+)(st|nd|rd|th)\b/g, '$1');
  // Directions
  const dirMap = {
    'north':'n', 'south':'s', 'east':'e', 'west':'w',
    'northeast':'ne', 'northwest':'nw', 'southeast':'se', 'southwest':'sw',
  };
  n = n.replace(/\b(north|south|east|west|northeast|northwest|southeast|southwest)\b/g, m => dirMap[m] || m);
  // Street suffixes
  const sufMap = {
    avenue:'ave', street:'st', boulevard:'blvd', road:'rd',
    drive:'dr', lane:'ln', court:'ct', place:'pl',
    parkway:'pkwy', terrace:'ter', circle:'cir', square:'sq',
    trail:'trl', expressway:'expy',
  };
  n = n.replace(/\b(avenue|street|boulevard|road|drive|lane|court|place|parkway|terrace|circle|square|trail|expressway)\b/g, m => sufMap[m] || m);
  // Strip everything that isn't alphanumeric or space
  n = n.replace(/[^a-z0-9 ]+/g, ' ');
  // Collapse whitespace
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

// v144: substring match against the normalized form of both query and
// haystack — handles "1616 nj 77" finding "1616 New Jersey 77 ..." etc.
export function _addrMatches(haystack, queryNorm){
  if(!queryNorm) return true;
  return _normalizeAddr(haystack).indexOf(queryNorm) !== -1;
}

// Strips type-prefix and agent-suffix junk from addresses like
//   "WH 36k SqFT - 25 Weldon Rd, Lake Hopatcong - DK"
//   "MF 4U - 13 W 18Th St, Bayonne- RR"
//   "RT- 5.5k Strip - 1870 N Olden Ave, Ewing - AA"
//   "MF- 51-53 Lincoln Park, Newark, NJ 07102 & 67-69 Lincoln Park..."
// Returns just the street/city/state/zip portion as a plain string.
export function cleanAddress(raw){
  if(!raw) return '';
  let s = raw.trim();

  // Strip trailing agent initials: " - DK", " -AA", " - SKY", " -JD/DK", " -- TE"
  // Match: optional spaces, 1-2 dashes, optional spaces, 1-6 uppercase letters (optionally / or space separated), end
  s = s.replace(/\s*-{1,2}\s*[A-Z]{1,4}(\/[A-Z]{1,4})?(\s*\/\s*[A-Z]{1,4})?\s*$/i, '');

  // Some deals have the agent in parens or at the very end without a dash: " AA" at end
  s = s.replace(/\s+-?[A-Z]{2,4}$/,'').trim();

  // Strip leading type prefix if present. We look for " - " and check what's before.
  // A type prefix is: starts with 1-6 letters, contains no digits matching a street number pattern
  // (i.e. no "123 " at the start of it).
  const dashMatch = s.match(/^([^-]{1,60}?)\s*-\s*(.+)$/);
  if(dashMatch){
    const before = dashMatch[1].trim();
    const after = dashMatch[2].trim();
    // If "before" looks like a type prefix — starts with a letter, doesn't look like a street number
    // e.g. "WH 36k SqFT", "MF 4U", "RT", "MHP 18 + 2U", "84U Dev", "Hotel 29U"
    // But NOT: "1870 N Olden Ave" (starts with digit)
    // And NOT: a full city name if the address is "Newark - Essex County" style
    const startsWithDigit = /^\d/.test(before);
    const hasStreetSuffix = /\b(st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pl|place|hwy|highway|route|rt\d)\b/i.test(before);
    // Typical type prefixes contain unit counts like "4U", "45U", "229U", or identifiers like
    // "WH", "MF", "RT", "Dev", "Hotel", "Motel", "MU", "MHP", "O/RT", "NNN", "Bentley", "RH", etc.
    const looksLikePrefix = !startsWithDigit && !hasStreetSuffix && before.length < 40;
    if(looksLikePrefix){
      s = after;
    }
  }

  // Some addresses have a leading "RT- " or "MF- " (dash without spaces). Handle those too.
  s = s.replace(/^([A-Z]{1,4}[A-Z0-9+/]{0,8})\s*-\s+/i, (match, p1) => {
    // Only strip if p1 doesn't contain a street-style word
    if(/\b(st|ave|rd|blvd|ln|dr|ct|way|pl|hwy|route)\b/i.test(p1)) return match;
    return '';
  });

  // Collapse whitespace and stray commas
  s = s.replace(/\s+/g,' ').replace(/\s*,\s*/g,', ').replace(/^,\s*|\s*,$/g,'').trim();
  return s;
}

// Splits a concatenated address string into its components.
export function parseAddress(fullAddr){
  if(!fullAddr) return {street:'',city:'',state:'New Jersey',zip:''};
  const zipMatch=fullAddr.match(/\b(\d{5})\b/);
  const zip=zipMatch?zipMatch[1]:'';
  let state='New Jersey';
  if(/\bPA\b|Pennsylvania/i.test(fullAddr))     state='Pennsylvania';
  else if(/\bNY\b|New York/i.test(fullAddr))    state='New York';
  else if(/\bCT\b|Connecticut/i.test(fullAddr)) state='Connecticut';
  else if(/\bDE\b|Delaware/i.test(fullAddr))    state='Delaware';
  else if(/\bMD\b|Maryland/i.test(fullAddr))    state='Maryland';
  let cleaned=fullAddr
    .replace(/\s*\d{5}(-\d{4})?\s*/g,' ')
    .replace(/,?\s*New Jersey\s*/gi,'').replace(/,?\s*Pennsylvania\s*/gi,'')
    .replace(/,?\s*New York\s*/gi,'').replace(/,?\s*Connecticut\s*/gi,'')
    .replace(/,?\s*Delaware\s*/gi,'').replace(/,?\s*Maryland\s*/gi,'')
    .replace(/,?\s*\bNJ\b\s*/gi,'').replace(/,?\s*\bPA\b\s*/gi,'')
    .replace(/,?\s*\bNY\b\s*/gi,'').replace(/,?\s*\bCT\b\s*/gi,'')
    .replace(/,?\s*\bDE\b\s*/gi,'').replace(/,?\s*\bMD\b\s*/gi,'')
    .replace(/\s*,\s*,+\s*/g,', ').replace(/^,+|,+$/g,'').trim();
  const parts=cleaned.split(',').map(p=>p.trim()).filter(Boolean);
  return {street:parts[0]||'', city:parts[1]||'', state, zip};
}
