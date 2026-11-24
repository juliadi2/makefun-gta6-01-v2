// config.js — shared constants for CAYO VERDE (gta6-01 v2).
// Distances are in world units (1 unit ~ 1 metre).

export const CFG = {
  BLOCK: 40, // city block size (square)
  ROAD: 12, // road width
  PITCH: 52, // BLOCK + ROAD: distance between road centrelines
  GRID: 9, // road lines per axis (centrelines at -208..208)
  HALF: 234, // half-extent of the built-up city (4.5 * PITCH)
  BEACH_X: 234, // beach strip starts east of this x
  WATER_X: 300, // open water starts east of this x
  SEED: 7, // world seed (overridable with ?seed= in the URL)
  CITY_NAME: 'Cayo Verde',
  GAME_TITLE: 'CAYO VERDE',
  colors: {
    ground: 0xc2a878,
    road: 0x3a3f4a,
    sidewalk: 0x9a938a,
    water: 0x1fa8c9,
    sand: 0xe8d8a8,
    building: [0xf2e3c6, 0xf0b8a0, 0xa8d8c8, 0xa8c8e8, 0xe8d060, 0xd8a8c8],
    palm: 0x2e8b57,
    leaf: 0x3aa655,
  },
};
