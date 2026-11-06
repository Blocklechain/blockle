import 'package:flutter/material.dart';

// ---- master icon set (name -> {viewBox, body}) + emoji map, generated ----
const Map<String, _IconDef> _kIcons = {
  'check': _IconDef('0 0 24 24', '<path d="M4.5 12.5l4.5 4.5 10.5-11" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'check-circle': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M8 12.2l2.6 2.6 5.4-5.6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'x': _IconDef('0 0 24 24', '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'bot': _IconDef('0 0 24 24', '<rect x="4.5" y="8" width="15" height="10.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 8V4.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><circle cx="12" cy="3.6" r="1.2" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M2.8 12.5v2.5M21.2 12.5v2.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><circle cx="9.2" cy="13" r="1.15" fill="currentColor"/><circle cx="14.8" cy="13" r="1.15" fill="currentColor"/>'),
  'launch': _IconDef('0 0 24 24', '<path d="M12 2.5c2.7 1.9 4.2 4.9 4.2 8.4L12 15.6l-4.2-4.7C7.8 7.4 9.3 4.4 12 2.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><circle cx="12" cy="9.2" r="1.6" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M7.8 13l-2.3 2.3.4 3.2 2.6-1.8M16.2 13l2.3 2.3-.4 3.2-2.6-1.8M10 18l2 3 2-3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'warning': _IconDef('0 0 24 24', '<path d="M12 3.5L2.8 20h18.4z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 9.5v4.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><circle cx="12" cy="17.4" r="0.6" fill="currentColor"/>'),
  'coin': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 7.5l4.5 4.5-4.5 4.5-4.5-4.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'target': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/>'),
  'chart-up': _IconDef('0 0 24 24', '<path d="M4 4v16h16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 15l3.5-4 3 2.5L20 7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 7h4v4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'chart-down': _IconDef('0 0 24 24', '<path d="M4 4v16h16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 9l3.5 4 3-2.5L20 17" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 17h4v-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'bars': _IconDef('0 0 24 24', '<path d="M4 20h16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M6.5 20v-6M12 20V7M17.5 20v-9" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'bolt': _IconDef('0 0 24 24', '<path d="M13 2.5L5.5 13H11l-2 8.5L18.5 10H13z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'moon': _IconDef('0 0 24 24', '<path d="M20 14.2A8.3 8.3 0 119.8 4 6.5 6.5 0 0020 14.2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'sun': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="4.3" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 2.2v2.6M12 19.2v2.6M21.8 12h-2.6M4.8 12H2.2M18.95 5.05l-1.84 1.84M6.89 17.11l-1.84 1.84M18.95 18.95l-1.84-1.84M6.89 6.89L5.05 5.05" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'cloud': _IconDef('0 0 24 24', '<path d="M7 18.5h9.5a4.2 4.2 0 00.4-8.38A5.6 5.6 0 006.3 9.2 4.6 4.6 0 007 18.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'shield': _IconDef('0 0 24 24', '<path d="M12 3l7 2.4v5.8c0 4.6-3 7.7-7 9.3-4-1.6-7-4.7-7-9.3V5.4z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'gem': _IconDef('0 0 24 24', '<path d="M5 9.5l3.2-4h7.6L19 9.5 12 19z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M5 9.5h14M9 5.5L7.5 9.5 12 19M15 5.5L16.5 9.5 12 19" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'brain': _IconDef('0 0 24 24', '<path d="M12 5.8a3 3 0 00-5.4 1.7A3 3 0 005 12a3 3 0 001.6 5.1A3 3 0 0012 18.4z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 5.8a3 3 0 015.4 1.7A3 3 0 0119 12a3 3 0 01-1.6 5.1A3 3 0 0112 18.4z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 5.8v12.6" fill="none" stroke="currentColor" stroke-width="1.75"/>'),
  'award': _IconDef('0 0 24 24', '<path d="M12 3.3l2.5 5.1 5.6.8-4.05 3.95.96 5.6L12 16.1l-5.07 2.65.96-5.6L3.84 9.2l5.6-.8z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'fire': _IconDef('0 0 24 24', '<path d="M12 3c.8 2.8-.9 4.3-1 6.3-.05 1.3-1.4 1.9-2.1.8-.6 1.6.3 3.2.3 4.2A4.5 4.5 0 0012 20.5a4.5 4.5 0 004.6-5.2c-.3-2.6-2.1-4.1-2.6-6.6-1 1-.9 2.4-1.9 2.6.1-2.6 1.4-5.2-.1-8.3z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'lock': _IconDef('0 0 24 24', '<rect x="5" y="10.5" width="14" height="10" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M8 10.5V7.4a4 4 0 018 0v3.1" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M12 14v3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'unlock': _IconDef('0 0 24 24', '<rect x="5" y="10.5" width="14" height="10" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M8 10.5V7.4a4 4 0 017.7-1.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M12 14v3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'crab': _IconDef('0 0 24 24', '<path d="M7.5 13a4.5 4.5 0 019 0" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M7.5 13v1.5M16.5 13v1.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><circle cx="10" cy="11.6" r="0.8" fill="currentColor"/><circle cx="14" cy="11.6" r="0.8" fill="currentColor"/><path d="M7.3 11.5L4.5 9 3 10.6l2 1.4M16.7 11.5L19.5 9 21 10.6l-2 1.4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 15.5c-1.4.8-2.6 1-3.8 2.3M8 16.5c-1 1.2-2.2 1.6-3.2 3.2M17 15.5c1.4.8 2.6 1 3.8 2.3M16 16.5c1 1.2 2.2 1.6 3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'block': _IconDef('0 0 24 24', '<path d="M12 2.5l8.2 4.6v9.8L12 21.5l-8.2-4.6V7.1z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 12l8.2-4.9M12 12v9.5M12 12L3.8 7.1" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'hexagon': _IconDef('0 0 24 24', '<path d="M12 2.5l8.2 4.6v9.8L12 21.5l-8.2-4.6V7.1z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'boom': _IconDef('0 0 24 24', '<path d="M12 2.5l1.9 4.6 4.1-2.7-1.2 4.8 4.9.2-3.8 3.1 3.2 3.7-4.8-1.2.5 4.9-3.5-3.4-3.5 3.4.5-4.9-4.8 1.2 3.2-3.7-3.8-3.1 4.9-.2-1.2-4.8 4.1 2.7z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'learn': _IconDef('0 0 24 24', '<path d="M12 5.5L3 9.3l9 3.8 9-3.8z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M7 11.4v4.2c0 1.5 2.3 2.6 5 2.6s5-1.1 5-2.6v-4.2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M21 9.3v4.7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'image': _IconDef('0 0 24 24', '<rect x="3.8" y="5" width="16.4" height="14" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="9" cy="10" r="1.7" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M4.2 16.5l4.3-4 3.5 3 3.2-2.7L20 16.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'link': _IconDef('0 0 24 24', '<path d="M9.5 14.5l5-5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M8.3 12.2l-2 2a3.6 3.6 0 005.1 5.1l2-2M15.7 11.8l2-2a3.6 3.6 0 00-5.1-5.1l-2 2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'tools': _IconDef('0 0 24 24', '<path d="M14.8 6.3a3.6 3.6 0 00-4.85 4.45L4 16.6 7.4 20l5.85-5.95a3.6 3.6 0 004.45-4.85l-2.35 2.35-2.3-.6-.6-2.3z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'key': _IconDef('0 0 24 24', '<circle cx="8" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M10.6 10.6L19 19M16.2 16.2l1.8-1.8M18.4 18.4l1.8-1.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'edit': _IconDef('0 0 24 24', '<path d="M5 19l1-4.2L16 4.8l3.2 3.2L9 18.2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M14 6.8l3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.75"/>'),
  'globe': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17" fill="none" stroke="currentColor" stroke-width="1.75"/>'),
  'gift': _IconDef('0 0 24 24', '<rect x="4" y="9" width="16" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M3 9h18M12 9v11" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 9S9.2 9 8.2 7.6 9 4.4 12 9c3-4.6 4.8-2.8 3.8-1.4S12 9 12 9z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'wave': _IconDef('0 0 24 24', '<path d="M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'download': _IconDef('0 0 24 24', '<path d="M12 3.5v11M8 10.5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19.5h14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'helmet': _IconDef('0 0 24 24', '<path d="M4 16a8 8 0 0116 0z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M2.8 16h18.4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M10 8.3V6.4h4v1.9" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M9 9a8 8 0 00-2.6 5M15 9a8 8 0 012.6 5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'plug': _IconDef('0 0 24 24', '<path d="M9 3.5v4.5M15 3.5v4.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M6.8 8h10.4v2.2a5.2 5.2 0 01-10.4 0z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 15.5v5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'scales': _IconDef('0 0 24 24', '<path d="M12 4v16M6 20h12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M4.5 8h15M12 4.5L5 8M12 4.5L19 8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 8l-2.3 4.8a2.8 2.8 0 004.6 0zM19 8l-2.3 4.8a2.8 2.8 0 004.6 0z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'gear': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 2.6v3M12 18.4v3M21.4 12h-3M5.6 12h-3M18.65 5.35l-2.1 2.1M7.45 16.55l-2.1 2.1M18.65 18.65l-2.1-2.1M7.45 7.45l-2.1-2.1" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'unicorn': _IconDef('0 0 24 24', '<path d="M6.5 20c-1-5 .8-9.5 5-11l1.5-5.5 1.6 3.2 3.2-.5-1.1 3.8c1.6 1.7 2.3 4.2 2.3 10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13.2" cy="11" r="0.8" fill="currentColor"/>'),
  'network': _IconDef('0 0 24 24', '<circle cx="12" cy="5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="5" cy="18" r="2.3" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="19" cy="18" r="2.3" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M10.6 6.9L6.4 16.1M13.4 6.9l4.2 9.2M7 18h10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'mail': _IconDef('0 0 24 24', '<rect x="3.5" y="5.5" width="17" height="13" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M4.2 7.5l7.8 5.8 7.8-5.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'desktop': _IconDef('0 0 24 24', '<rect x="3.5" y="4.5" width="17" height="11.5" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M8 19.5h8M12 16v3.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'heart': _IconDef('0 0 24 24', '<path d="M12 20.3S4 15.5 4 9.6A4.6 4.6 0 0112 7a4.6 4.6 0 018 2.6c0 5.9-8 10.7-8 10.7z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'dot': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="4.2" fill="currentColor"/>'),
  'live': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="4.8" fill="#ef4444"/><circle cx="12" cy="12" r="8.6" fill="none" stroke="#ef4444" stroke-width="1.75" opacity="0.45"/>'),
  'online': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="4.8" fill="#22c55e"/>'),
  'construction': _IconDef('0 0 24 24', '<rect x="3.5" y="8.5" width="17" height="6" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M5 14.5L9.5 8.5M11 14.5L15.5 8.5M17 14.5l3-3.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M6 14.5v5M18 14.5v5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'swords': _IconDef('0 0 24 24', '<path d="M18 4h2v2l-7 7-2-2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M6 4H4v2l7 7 2-2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M13 13l4 4M16 15l2 2 1-1-2-2M11 13l-4 4M8 15l-2 2-1-1 2-2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'flask': _IconDef('0 0 24 24', '<path d="M9 3.5h6M10 3.5v6l-4.6 8.2A1.8 1.8 0 007 20.5h10a1.8 1.8 0 001.6-2.8L14 9.5v-6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M7.2 14.5h9.6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'ring': _IconDef('0 0 24 24', '<circle cx="12" cy="14.5" r="5.3" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M9.5 9.6L12 4l2.5 5.6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M9.5 9.6h5" fill="none" stroke="currentColor" stroke-width="1.75"/>'),
  'beads': _IconDef('0 0 24 24', '<circle cx="12" cy="5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="16.9" cy="7" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="18.9" cy="11.9" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="16.9" cy="16.8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7.1" cy="7" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.1" cy="11.9" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7.1" cy="16.8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="18.9" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
  'bow': _IconDef('0 0 24 24', '<path d="M4 20L18 6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M18 6h-4.2M18 6v4.2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 6.5a13 13 0 0111 11" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M6.5 6.5L17.5 17.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" opacity="0.55"/>'),
  'wand': _IconDef('0 0 24 24', '<path d="M5 19L14.5 9.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M16.5 4.2l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M20 12l.4 1.3 1.3.4-1.3.4-.4 1.3-.4-1.3-1.3-.4 1.3-.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'),
  'axe': _IconDef('0 0 24 24', '<path d="M6 19.5L13.5 12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M12 5.5a7 7 0 015.2 6.3l-3.4 1.2L10.3 9.4l1.3-3.5c.1-.1.3-.3.4-.4z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'rock': _IconDef('0 0 24 24', '<path d="M4 15l3.2-5.5 5-1.8 6.3 3.2 1.2 5-4.3 3.1H7z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M7.2 9.5l3.3 4.3 5.2-1.1M10.5 13.8L8.3 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'log': _IconDef('0 0 24 24', '<path d="M4 8h12a4 4 0 010 8H4a4 4 0 010-8z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><ellipse cx="16" cy="12" rx="2" ry="4" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="16" cy="12" r="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
  'fish': _IconDef('0 0 24 24', '<path d="M3 12c3-4.2 9.5-5 13.5 0-4 5-10.5 4.2-13.5 0z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M16.5 12l4.5-3.2v6.4z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><circle cx="7" cy="11" r="0.8" fill="currentColor"/>'),
  'menu': _IconDef('0 0 24 24', '<path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'sparkle': _IconDef('0 0 24 24', '<path d="M12 3c.6 4.3 1.7 5.4 6 6-4.3.6-5.4 1.7-6 6-.6-4.3-1.7-5.4-6-6 4.3-.6 5.4-1.7 6-6z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M18.5 14.5c.25 1.9.75 2.4 2.5 2.7-1.75.3-2.25.8-2.5 2.7-.25-1.9-.75-2.4-2.5-2.7 1.75-.3 2.25-.8 2.5-2.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'),
  'slider': _IconDef('0 0 24 24', '<path d="M4 8.5h16M4 15.5h16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><circle cx="9" cy="8.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="15" cy="15.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.75"/>'),
  'run': _IconDef('0 0 24 24', '<circle cx="14.5" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M13.5 9.2l-3.5 3.3 3.3 2.5 1.2 4.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 12.5l-3.5.8M13.3 15l-2.8 4.5M13.8 10.5l3.7 1.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'money-bag': _IconDef('0 0 24 24', '<path d="M8.5 7.5h7l-1.8 2.8c2.9 1.4 4.3 3.9 4.3 6.1A4.1 4.1 0 0113.9 20.5h-3.8A4.1 4.1 0 016 16.4c0-2.2 1.4-4.7 4.3-6.1z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M8.5 7.5l1-3.5h5l1 3.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 13v4.5M10.6 14h2.6a1.2 1.2 0 010 2.4h-2.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
  'stop': _IconDef('0 0 24 24', '<path d="M8.4 3h7.2L21 8.4v7.2L15.6 21H8.4L3 15.6V8.4z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M9 12h6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'cube': _IconDef('0 0 24 24', '<path d="M12 2.8l8 4v8.4l-8 4-8-4V6.8z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M4 6.8l8 4 8-4M12 10.8v8.4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'shuffle': _IconDef('0 0 24 24', '<path d="M17.5 4l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M17.5 14l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 7h3.4c2 0 3.3 1 4.5 2.8l3 4.4c1.2 1.8 2.5 2.8 4.5 2.8h2.1" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 17h3.4c2 0 3.3-1 4.5-2.8M15.5 9.8C16.7 8 18 7 20 7h.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'gas': _IconDef('0 0 24 24', '<path d="M5 20.5V6a2.2 2.2 0 012.2-2.2h4.6A2.2 2.2 0 0114 6v14.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M3.8 20.5h11.4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M7 7.5h5v3.5H7z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M14 9h2.3a1.6 1.6 0 011.6 1.6v4.9a1.5 1.5 0 003 0V8.5l-2.4-2.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'),
  'flag': _IconDef('0 0 24 24', '<path d="M6 21V4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M6 4.5h11.5l-2.7 3.8 2.7 3.8H6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'satellite': _IconDef('0 0 24 24', '<path d="M5.5 14.5l4-4M9.5 10.5L5.5 6.5l3-3 4 4M12.5 7.5l3-3 4 4-3 3M15.5 11.5l-4 4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.5 13.5a4 4 0 01-4 4M16.5 16.5a7 7 0 01-7 7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'penguin': _IconDef('0 0 24 24', '<path d="M12 3a5 5 0 015 5v6a5 5 0 01-10 0V8a5 5 0 015-5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 7.5c1.6 0 2.6 1.2 2.6 4S13.6 16 12 16s-2.6-1.2-2.6-4.5S10.4 7.5 12 7.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="10.3" cy="7.6" r="0.7" fill="currentColor"/><circle cx="13.7" cy="7.6" r="0.7" fill="currentColor"/><path d="M11 9.3l1 1.1 1-1.1z" fill="currentColor" stroke="currentColor" stroke-width="0.8" stroke-linejoin="round"/><path d="M8.5 18.5L7 21M15.5 18.5L17 21" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'spiral': _IconDef('0 0 24 24', '<path d="M11.8 12.2a1.7 1.7 0 112.1-1.6 3.8 3.8 0 01-3.8 3.8 5.9 5.9 0 01-5.9-5.9 8 8 0 018-8 8.1 8.1 0 018 7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'puzzle': _IconDef('0 0 24 24', '<path d="M9.5 4.5a2 2 0 014 0 1 1 0 001 1h3.5v3.5a1 1 0 001 1 2 2 0 010 4 1 1 0 00-1 1V18h-3.5a1 1 0 01-1-1 2 2 0 00-4 0 1 1 0 01-1 1H5v-3.5a1 1 0 00-1-1 2 2 0 010-4 1 1 0 001-1V5h3.5a1 1 0 001-1z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'planet': _IconDef('0 0 24 24', '<circle cx="12" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M6.4 13.8c-2.6 1.5-4.1 3.1-3.5 4.3.9 1.8 5.9.8 11.2-2.2s8.8-6.6 7.9-8.4c-.6-1.2-2.6-1.2-5.2-.3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'chat': _IconDef('0 0 24 24', '<path d="M20 15.5a2 2 0 01-2 2H9l-4 4V6a2 2 0 012-2h10a2 2 0 012 2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><circle cx="8.5" cy="10.5" r="0.95" fill="currentColor"/><circle cx="12" cy="10.5" r="0.95" fill="currentColor"/><circle cx="15.5" cy="10.5" r="0.95" fill="currentColor"/>'),
  'party': _IconDef('0 0 24 24', '<path d="M4 20.5l5.5-13 7.5 7.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M6 15l4.5-1.8M5 17.8l3-1" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M14 4l1 1.2M18.5 3.5l-.6 2.3M20.5 8l-2.3.6M15.5 9.5l1.5 1.3M19.5 12.5l.1 2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
  'seed': _IconDef('0 0 24 24', '<path d="M12 20.5v-7.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M12 13c0-3.3-2.2-5.4-5.5-5.4C6.1 10.9 8.4 13 12 13z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 11.5c0-2.8 2-4.8 5.2-4.8C17.5 9.6 15.3 11.5 12 11.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'compass': _IconDef('0 0 24 24', '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M15.2 8.8l-1.9 4.5-4.5 1.9 1.9-4.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><circle cx="12" cy="12" r="0.9" fill="currentColor"/>'),
  'book': _IconDef('0 0 24 24', '<path d="M4 5.2A2.2 2.2 0 016.2 3H19v15.5H6.2A2.2 2.2 0 004 20.7z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M4 18.5A2.2 2.2 0 016.2 16.3H19" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>'),
  'pickaxe': _IconDef('0 0 24 24', '<path d="M12.5 11.5L5 19.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M5.5 8.2c4-2.3 8.5-1.6 12.8 2.1M8.2 5.5c-2.3 4-1.6 8.5 2.1 12.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>'),
};

const Map<String, String> _kEmojiToName = {
  '✓': 'check',
  '🤖': 'bot',
  '🚀': 'launch',
  '⚠': 'warning',
  '🪙': 'coin',
  '🎯': 'target',
  '📈': 'chart-up',
  '⚡': 'bolt',
  '☾': 'moon',
  '☁': 'cloud',
  '✗': 'x',
  '🛡': 'shield',
  '💎': 'gem',
  '☀': 'sun',
  '🧠': 'brain',
  '🏅': 'award',
  '🔥': 'fire',
  '📉': 'chart-down',
  '🔒': 'lock',
  '📊': 'bars',
  '🦀': 'crab',
  '🧱': 'block',
  '🔴': 'live',
  '💥': 'boom',
  '🎓': 'learn',
  '🖼': 'image',
  '🔗': 'link',
  '🛠': 'tools',
  '🔑': 'key',
  '✎': 'edit',
  '🌍': 'globe',
  '🎁': 'gift',
  '🌊': 'wave',
  '⬇': 'download',
  '✕': 'x',
  '🔓': 'unlock',
  '⛑': 'helmet',
  '🔌': 'plug',
  '⛓': 'link',
  '✅': 'check-circle',
  '⚖': 'scales',
  '⚙': 'gear',
  '⬡': 'hexagon',
  '🦄': 'unicorn',
  '🌐': 'network',
  '✉': 'mail',
  '🔐': 'lock',
  '🖥': 'desktop',
  '💚': 'heart',
  '⬤': 'dot',
  '🚧': 'construction',
  '⚔': 'swords',
  '🧪': 'flask',
  '💍': 'ring',
  '📿': 'beads',
  '🏹': 'bow',
  '🪄': 'wand',
  '🪓': 'axe',
  '🪨': 'rock',
  '🪵': 'log',
  '🐟': 'fish',
  '🗝': 'lock',
  '★': 'award',
  '☰': 'menu',
  '✨': 'sparkle',
  '❌': 'x',
  '🎚': 'slider',
  '🏃': 'run',
  '💰': 'money-bag',
  '🛑': 'stop',
  '🧊': 'cube',
  '💸': 'money-bag',
  '🔀': 'shuffle',
  '⬩': 'dot',
  '✦': 'sparkle',
  '⛽': 'gas',
  '⚑': 'flag',
  '🛰': 'satellite',
  '🟢': 'online',
  '🎖': 'award',
  '🐧': 'penguin',
  '🌀': 'spiral',
  '🧩': 'puzzle',
  '🪐': 'planet',
  '💬': 'chat',
  '🎉': 'party',
  '🌱': 'seed',
  '🧭': 'compass',
  '✍': 'edit',
  '📖': 'book',
  '⛏': 'pickaxe',
};

// app_icons.dart — the custom Blockle SVG icon set, rendered natively (no
// flutter_svg dependency) via a small CustomPainter that parses each icon's
// inline SVG body (paths, circles, rects, ellipses) into a flutter Path.
//
// Usage:
//   AppIcons.icon('coin', size: 28, color: t.warn)   // by icon name
//   AppIcons.glyph(someString, size: 16)             // name OR emoji OR plain text
//
// Icons inherit the ambient color (IconTheme / DefaultTextStyle) when no color
// is passed — i.e. SVG `currentColor` resolves to the surrounding text color,
// so an icon can drop straight into a Row next to a Text() and match it.
//
// The icon bodies and the emoji->name map are the authoritative master set
// (shared verbatim with the extension/web/Qt icon sets).

class _IconDef {
  final String viewBox;
  final String body;
  const _IconDef(this.viewBox, this.body);
}

/// Custom Blockle icon set. All drawing is native (CustomPainter) — safe on
/// every Flutter target with no extra package.
class AppIcons {
  const AppIcons._();

  /// True if [name] is a known icon in the master set.
  static bool has(String name) => _kIcons.containsKey(name);

  /// Resolve an icon name, an emoji, or an emoji+variation-selector to a known
  /// icon name. Returns null when nothing matches.
  static String? resolveName(String s) {
    if (_kIcons.containsKey(s)) return s;
    final byEmoji = _kEmojiToName[s];
    if (byEmoji != null) return byEmoji;
    final stripped = s.replaceAll('️', '');
    return _kEmojiToName[stripped];
  }

  /// Render the icon [name] from the master set. Unknown names render empty
  /// (a sized, transparent box) so a typo never crashes the surface.
  static Widget icon(String name, {double size = 20, Color? color}) =>
      _SvgIcon(name: name, size: size, color: color);

  /// Render [s] as an icon when it resolves (by name or emoji); otherwise fall
  /// back to plain text. Handy for data fields that may still hold a glyph.
  static Widget glyph(String s, {double size = 16, Color? color}) {
    final n = resolveName(s);
    if (n != null) return icon(n, size: size, color: color);
    return Text(s, style: TextStyle(fontSize: size, color: color));
  }

  /// Render an arbitrary inline-SVG [body] (the same subset the icon set uses:
  /// path / circle / rect / ellipse, hex or `currentColor` fills + strokes,
  /// opacity). [cacheKey] must be STABLE and UNIQUE per distinct body so the
  /// parsed-path cache is reused. Used by the brand-logo set (chain_icon.dart)
  /// for full-colour marks that carry their own explicit fills. Shapes without
  /// an explicit colour inherit [color] (or the ambient text colour).
  static Widget rawSvg(String cacheKey, String body,
          {String viewBox = '0 0 24 24', double size = 20, Color? color}) =>
      _SvgBody(
          cacheKey: cacheKey, body: body, viewBox: viewBox, size: size, color: color);
}

class _SvgBody extends StatelessWidget {
  const _SvgBody({
    required this.cacheKey,
    required this.body,
    required this.viewBox,
    required this.size,
    this.color,
  });
  final String cacheKey;
  final String body;
  final String viewBox;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final resolved = color ??
        IconTheme.of(context).color ??
        DefaultTextStyle.of(context).style.color ??
        const Color(0xFF000000);
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _IconPainter(cacheKey, _IconDef(viewBox, body), resolved),
      ),
    );
  }
}

class _SvgIcon extends StatelessWidget {
  const _SvgIcon({required this.name, required this.size, this.color});
  final String name;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final def = _kIcons[name];
    if (def == null) return SizedBox(width: size, height: size);
    final resolved = color ??
        IconTheme.of(context).color ??
        DefaultTextStyle.of(context).style.color ??
        const Color(0xFF000000);
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _IconPainter(name, def, resolved),
      ),
    );
  }
}

class _Shape {
  final Path path;
  final bool doFill;
  final bool doStroke;
  final Color? fillColor; // null => currentColor
  final Color? strokeColor; // null => currentColor
  final double strokeWidth;
  final StrokeCap cap;
  final StrokeJoin join;
  final double opacity;
  _Shape(this.path, this.doFill, this.doStroke, this.fillColor,
      this.strokeColor, this.strokeWidth, this.cap, this.join, this.opacity);
}

class _ParsedIcon {
  final double w;
  final double h;
  final List<_Shape> shapes;
  _ParsedIcon(this.w, this.h, this.shapes);
}

class _IconPainter extends CustomPainter {
  _IconPainter(this.name, this.def, this.color);
  final String name;
  final _IconDef def;
  final Color color;

  static final Map<String, _ParsedIcon> _cache = {};

  @override
  void paint(Canvas canvas, Size size) {
    final parsed = _cache.putIfAbsent(name, () => _parse(def));
    if (parsed.w <= 0 || parsed.h <= 0) return;
    canvas.save();
    canvas.scale(size.width / parsed.w, size.height / parsed.h);
    for (final s in parsed.shapes) {
      if (s.doFill) {
        final base = s.fillColor ?? color;
        final c = s.opacity >= 1.0
            ? base
            : base.withValues(alpha: base.a * s.opacity);
        canvas.drawPath(s.path, Paint()..color = c..style = PaintingStyle.fill);
      }
      if (s.doStroke) {
        final base = s.strokeColor ?? color;
        final c = s.opacity >= 1.0
            ? base
            : base.withValues(alpha: base.a * s.opacity);
        canvas.drawPath(
          s.path,
          Paint()
            ..color = c
            ..style = PaintingStyle.stroke
            ..strokeWidth = s.strokeWidth
            ..strokeCap = s.cap
            ..strokeJoin = s.join,
        );
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_IconPainter old) =>
      old.color != color || old.name != name;

  // ---- parsing --------------------------------------------------------------

  static final RegExp _elRe =
      RegExp(r'<(path|circle|rect|ellipse)\b([^>]*?)/?>');
  static final RegExp _attrRe = RegExp(r'([a-zA-Z-]+)="([^"]*)"');

  static _ParsedIcon _parse(_IconDef def) {
    final vb = def.viewBox.trim().split(RegExp(r'[ ,]+'));
    final double w = vb.length >= 3 ? (double.tryParse(vb[2]) ?? 24.0) : 24.0;
    final double h = vb.length >= 4 ? (double.tryParse(vb[3]) ?? 24.0) : 24.0;
    final shapes = <_Shape>[];
    for (final m in _elRe.allMatches(def.body)) {
      try {
        final tag = m.group(1)!;
        final attrs = <String, String>{};
        for (final a in _attrRe.allMatches(m.group(2)!)) {
          attrs[a.group(1)!] = a.group(2)!;
        }
        final path = Path();
        switch (tag) {
          case 'path':
            _applyPath(attrs['d'] ?? '', path);
            break;
          case 'circle':
            final cx = _d(attrs['cx']), cy = _d(attrs['cy']), r = _d(attrs['r']);
            path.addOval(Rect.fromCircle(center: Offset(cx, cy), radius: r));
            break;
          case 'ellipse':
            final cx = _d(attrs['cx']), cy = _d(attrs['cy']);
            final rx = _d(attrs['rx']), ry = _d(attrs['ry']);
            path.addOval(Rect.fromCenter(
                center: Offset(cx, cy), width: rx * 2, height: ry * 2));
            break;
          case 'rect':
            final x = _d(attrs['x']), y = _d(attrs['y']);
            final rw = _d(attrs['width']), rh = _d(attrs['height']);
            final rx = _d(attrs['rx']);
            final rect = Rect.fromLTWH(x, y, rw, rh);
            if (rx > 0) {
              path.addRRect(
                  RRect.fromRectAndRadius(rect, Radius.circular(rx)));
            } else {
              path.addRect(rect);
            }
            break;
        }
        final fill = attrs['fill'];
        final stroke = attrs['stroke'];
        final doFill = fill != null && fill != 'none';
        final doStroke = stroke != null && stroke != 'none';
        if (!doFill && !doStroke) continue;
        shapes.add(_Shape(
          path,
          doFill,
          doStroke,
          _hex(fill),
          _hex(stroke),
          double.tryParse(attrs['stroke-width'] ?? '') ?? 1.0,
          _cap(attrs['stroke-linecap']),
          _join(attrs['stroke-linejoin']),
          double.tryParse(attrs['opacity'] ?? '') ?? 1.0,
        ));
      } catch (_) {
        // Skip any malformed element rather than break the whole icon.
      }
    }
    return _ParsedIcon(w, h, shapes);
  }

  static double _d(String? v) => double.tryParse(v ?? '') ?? 0.0;

  static Color? _hex(String? v) {
    if (v == null || v == 'none' || v == 'currentColor') return null;
    var s = v.trim();
    if (!s.startsWith('#')) return null;
    s = s.substring(1);
    if (s.length == 3) {
      s = s.split('').map((c) => '$c$c').join();
    }
    if (s.length == 6) {
      final n = int.tryParse(s, radix: 16);
      if (n != null) return Color(0xFF000000 | n);
    }
    if (s.length == 8) {
      final n = int.tryParse(s, radix: 16);
      if (n != null) return Color(n);
    }
    return null;
  }

  static StrokeCap _cap(String? v) {
    switch (v) {
      case 'round':
        return StrokeCap.round;
      case 'square':
        return StrokeCap.square;
      default:
        return StrokeCap.butt;
    }
  }

  static StrokeJoin _join(String? v) {
    switch (v) {
      case 'round':
        return StrokeJoin.round;
      case 'bevel':
        return StrokeJoin.bevel;
      default:
        return StrokeJoin.miter;
    }
  }

  // ---- SVG path-data mini parser (M L H V C S Q T A Z, abs + rel) -----------

  static bool _isDigit(String c) => c.codeUnitAt(0) >= 48 && c.codeUnitAt(0) <= 57;
  static bool _isAlpha(String c) {
    final u = c.codeUnitAt(0);
    return (u >= 65 && u <= 90) || (u >= 97 && u <= 122);
  }

  static void _applyPath(String d, Path p) {
    int i = 0;
    final n = d.length;
    void skipSep() {
      while (i < n) {
        final c = d[i];
        if (c == ' ' || c == ',' || c == '\n' || c == '\t' || c == '\r') {
          i++;
        } else {
          break;
        }
      }
    }

    double readNum() {
      skipSep();
      final start = i;
      if (i < n && (d[i] == '+' || d[i] == '-')) i++;
      while (i < n && _isDigit(d[i])) {
        i++;
      }
      if (i < n && d[i] == '.') {
        i++;
        while (i < n && _isDigit(d[i])) {
        i++;
      }
      }
      if (i < n && (d[i] == 'e' || d[i] == 'E')) {
        i++;
        if (i < n && (d[i] == '+' || d[i] == '-')) i++;
        while (i < n && _isDigit(d[i])) {
        i++;
      }
      }
      return double.parse(d.substring(start, i));
    }

    int readFlag() {
      skipSep();
      final c = d[i];
      i++;
      return c == '1' ? 1 : 0;
    }

    double cx = 0, cy = 0, sx = 0, sy = 0;
    double ctrlX = 0, ctrlY = 0;
    bool prevCubic = false, prevQuad = false;
    String cmd = '';

    while (i < n) {
      skipSep();
      if (i >= n) break;
      final c = d[i];
      if (_isAlpha(c)) {
        cmd = c;
        i++;
      }
      bool curCubic = false, curQuad = false;
      switch (cmd) {
        case 'M':
          cx = readNum();
          cy = readNum();
          p.moveTo(cx, cy);
          sx = cx;
          sy = cy;
          cmd = 'L';
          break;
        case 'm':
          cx += readNum();
          cy += readNum();
          p.moveTo(cx, cy);
          sx = cx;
          sy = cy;
          cmd = 'l';
          break;
        case 'L':
          cx = readNum();
          cy = readNum();
          p.lineTo(cx, cy);
          break;
        case 'l':
          cx += readNum();
          cy += readNum();
          p.lineTo(cx, cy);
          break;
        case 'H':
          cx = readNum();
          p.lineTo(cx, cy);
          break;
        case 'h':
          cx += readNum();
          p.lineTo(cx, cy);
          break;
        case 'V':
          cy = readNum();
          p.lineTo(cx, cy);
          break;
        case 'v':
          cy += readNum();
          p.lineTo(cx, cy);
          break;
        case 'C':
          {
            final x1 = readNum(), y1 = readNum();
            final x2 = readNum(), y2 = readNum();
            final x = readNum(), y = readNum();
            p.cubicTo(x1, y1, x2, y2, x, y);
            ctrlX = x2;
            ctrlY = y2;
            cx = x;
            cy = y;
            curCubic = true;
          }
          break;
        case 'c':
          {
            final x1 = cx + readNum(), y1 = cy + readNum();
            final x2 = cx + readNum(), y2 = cy + readNum();
            final x = cx + readNum(), y = cy + readNum();
            p.cubicTo(x1, y1, x2, y2, x, y);
            ctrlX = x2;
            ctrlY = y2;
            cx = x;
            cy = y;
            curCubic = true;
          }
          break;
        case 'S':
          {
            final x1 = prevCubic ? 2 * cx - ctrlX : cx;
            final y1 = prevCubic ? 2 * cy - ctrlY : cy;
            final x2 = readNum(), y2 = readNum();
            final x = readNum(), y = readNum();
            p.cubicTo(x1, y1, x2, y2, x, y);
            ctrlX = x2;
            ctrlY = y2;
            cx = x;
            cy = y;
            curCubic = true;
          }
          break;
        case 's':
          {
            final x1 = prevCubic ? 2 * cx - ctrlX : cx;
            final y1 = prevCubic ? 2 * cy - ctrlY : cy;
            final x2 = cx + readNum(), y2 = cy + readNum();
            final x = cx + readNum(), y = cy + readNum();
            p.cubicTo(x1, y1, x2, y2, x, y);
            ctrlX = x2;
            ctrlY = y2;
            cx = x;
            cy = y;
            curCubic = true;
          }
          break;
        case 'Q':
          {
            final x1 = readNum(), y1 = readNum();
            final x = readNum(), y = readNum();
            p.quadraticBezierTo(x1, y1, x, y);
            ctrlX = x1;
            ctrlY = y1;
            cx = x;
            cy = y;
            curQuad = true;
          }
          break;
        case 'q':
          {
            final x1 = cx + readNum(), y1 = cy + readNum();
            final x = cx + readNum(), y = cy + readNum();
            p.quadraticBezierTo(x1, y1, x, y);
            ctrlX = x1;
            ctrlY = y1;
            cx = x;
            cy = y;
            curQuad = true;
          }
          break;
        case 'T':
          {
            final x1 = prevQuad ? 2 * cx - ctrlX : cx;
            final y1 = prevQuad ? 2 * cy - ctrlY : cy;
            final x = readNum(), y = readNum();
            p.quadraticBezierTo(x1, y1, x, y);
            ctrlX = x1;
            ctrlY = y1;
            cx = x;
            cy = y;
            curQuad = true;
          }
          break;
        case 't':
          {
            final x1 = prevQuad ? 2 * cx - ctrlX : cx;
            final y1 = prevQuad ? 2 * cy - ctrlY : cy;
            final x = cx + readNum(), y = cy + readNum();
            p.quadraticBezierTo(x1, y1, x, y);
            ctrlX = x1;
            ctrlY = y1;
            cx = x;
            cy = y;
            curQuad = true;
          }
          break;
        case 'A':
          {
            final rx = readNum(), ry = readNum(), rot = readNum();
            final laf = readFlag(), sf = readFlag();
            final x = readNum(), y = readNum();
            p.arcToPoint(Offset(x, y),
                radius: Radius.elliptical(rx, ry),
                rotation: rot,
                largeArc: laf == 1,
                clockwise: sf == 1);
            cx = x;
            cy = y;
          }
          break;
        case 'a':
          {
            final rx = readNum(), ry = readNum(), rot = readNum();
            final laf = readFlag(), sf = readFlag();
            final x = cx + readNum(), y = cy + readNum();
            p.arcToPoint(Offset(x, y),
                radius: Radius.elliptical(rx, ry),
                rotation: rot,
                largeArc: laf == 1,
                clockwise: sf == 1);
            cx = x;
            cy = y;
          }
          break;
        case 'Z':
        case 'z':
          p.close();
          cx = sx;
          cy = sy;
          break;
        default:
          // Unknown / no active command: advance to avoid an infinite loop.
          i++;
      }
      prevCubic = curCubic;
      prevQuad = curQuad;
    }
  }
}

