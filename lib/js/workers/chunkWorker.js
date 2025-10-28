/**
 * Chunk Worker - Multi-Instance Terrain Generation
 * 
 * This worker handles chunk generation, meshing, and updates for the voxel engine.
 * Multiple instances can run simultaneously for parallel chunk processing.
 * 
 * Features:
 * - Seed-based procedural terrain generation
 * - Multi-octave noise for realistic terrain
 * - Support for both "mesh" and "structure" block types
 * - Efficient face culling and geometry building
 * - Thread-safe chunk storage per worker instance
 */

'use strict';

// ============================================================================
// WORKER STATE - Isolated per worker instance
// ============================================================================

let CHUNK_SIZE, WORLD_HEIGHT, BLOCK_TYPES, SEA_LEVEL;
let blockProperties = {};  // Block properties from main thread
let worldSeed = 'DefaultSeed';  // Seed for deterministic generation

// Lookup tables built from BLOCK_TYPES + blockProperties
let idToProps = [];
let idToName = [];
let isTransparentById = [];
let blockTypeById = []; // "mesh", "structure", "solid", etc.

// Chunk storage for this worker instance
const chunkStorage = new Map();
const neighborChunkCache = new Map();

// ============================================================================
// NOISE GENERATION - Seeded Perlin/Simplex-like noise
// ============================================================================

/**
 * Seeded pseudo-random number generator
 * Uses a simple LCG (Linear Congruential Generator) for deterministic randomness
 */
class SeededRandom {
    constructor(seed) {
        this.seed = this.hashString(seed);
    }
    
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }
    
    // Returns a pseudo-random float between 0 and 1
    random() {
        this.seed = (this.seed * 1664525 + 1013904223) & 0xFFFFFFFF;
        return (this.seed >>> 0) / 0xFFFFFFFF;
    }
    
    // Returns a pseudo-random float between min and max
    range(min, max) {
        return min + this.random() * (max - min);
    }
    
    // Returns a pseudo-random integer between min (inclusive) and max (exclusive)
    int(min, max) {
        return Math.floor(this.range(min, max));
    }
}

/**
 * Simple 2D Perlin-like noise implementation
 * Based on gradient noise with smooth interpolation
 */
class NoiseGenerator {
    constructor(seed) {
        this.rng = new SeededRandom(seed);
        this.permutation = this.buildPermutationTable();
    }
    
    buildPermutationTable() {
        const p = new Uint8Array(512);
        const base = new Uint8Array(256);
        
        // Fill with 0-255
        for (let i = 0; i < 256; i++) {
            base[i] = i;
        }
        
        // Fisher-Yates shuffle
        for (let i = 255; i > 0; i--) {
            const j = this.rng.int(0, i + 1);
            [base[i], base[j]] = [base[j], base[i]];
        }
        
        // Duplicate for wrapping
        for (let i = 0; i < 512; i++) {
            p[i] = base[i & 255];
        }
        
        return p;
    }
    
    // Fade function for smooth interpolation
    fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }
    
    // Linear interpolation
    lerp(t, a, b) {
        return a + t * (b - a);
    }
    
    // Gradient function
    grad(hash, x, y) {
        const h = hash & 3;
        const u = h < 2 ? x : y;
        const v = h < 2 ? y : x;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }
    
    // 2D Perlin noise (-1 to 1)
    noise2D(x, y) {
        // Find unit square
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        
        // Relative position in square
        x -= Math.floor(x);
        y -= Math.floor(y);
        
        // Fade curves
        const u = this.fade(x);
        const v = this.fade(y);
        
        // Hash coordinates of square corners
        const p = this.permutation;
        const A = p[X] + Y;
        const B = p[X + 1] + Y;
        
        // Blend results from corners
        return this.lerp(v,
            this.lerp(u, this.grad(p[A], x, y), this.grad(p[B], x - 1, y)),
            this.lerp(u, this.grad(p[A + 1], x, y - 1), this.grad(p[B + 1], x - 1, y - 1))
        );
    }
    
    // 3D Perlin noise (-1 to 1)
    noise3D(x, y, z) {
        // Find unit cube
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        const Z = Math.floor(z) & 255;
        
        // Relative position in cube
        x -= Math.floor(x);
        y -= Math.floor(y);
        z -= Math.floor(z);
        
        // Fade curves
        const u = this.fade(x);
        const v = this.fade(y);
        const w = this.fade(z);
        
        // Hash coordinates of cube corners
        const p = this.permutation;
        const A = p[X] + Y;
        const AA = p[A] + Z;
        const AB = p[A + 1] + Z;
        const B = p[X + 1] + Y;
        const BA = p[B] + Z;
        const BB = p[B + 1] + Z;
        
        // Blend results from corners
        return this.lerp(w,
            this.lerp(v,
                this.lerp(u, this.grad3D(p[AA], x, y, z), this.grad3D(p[BA], x - 1, y, z)),
                this.lerp(u, this.grad3D(p[AB], x, y - 1, z), this.grad3D(p[BB], x - 1, y - 1, z))
            ),
            this.lerp(v,
                this.lerp(u, this.grad3D(p[AA + 1], x, y, z - 1), this.grad3D(p[BA + 1], x - 1, y, z - 1)),
                this.lerp(u, this.grad3D(p[AB + 1], x, y - 1, z - 1), this.grad3D(p[BB + 1], x - 1, y - 1, z - 1))
            )
        );
    }
    
    grad3D(hash, x, y, z) {
        const h = hash & 15;
        const u = h < 8 ? x : y;
        const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }
    
    /**
     * Multi-octave noise (fractal Brownian motion)
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} octaves - Number of octaves (layers of detail)
     * @param {number} persistence - Amplitude multiplier per octave (0-1)
     * @param {number} lacunarity - Frequency multiplier per octave (usually 2)
     * @param {number} scale - Initial frequency scale
     * @returns {number} - Combined noise value
     */
    octaveNoise2D(x, y, octaves = 4, persistence = 0.5, lacunarity = 2.0, scale = 1.0) {
        let total = 0;
        let frequency = scale;
        let amplitude = 1;
        let maxValue = 0; // Used for normalizing result
        
        for (let i = 0; i < octaves; i++) {
            total += this.noise2D(x * frequency, y * frequency) * amplitude;
            maxValue += amplitude;
            amplitude *= persistence;
            frequency *= lacunarity;
        }
        
        return total / maxValue; // Normalize to -1 to 1
    }
    
    /**
     * Multi-octave 3D noise
     */
    octaveNoise3D(x, y, z, octaves = 4, persistence = 0.5, lacunarity = 2.0, scale = 1.0) {
        let total = 0;
        let frequency = scale;
        let amplitude = 1;
        let maxValue = 0;
        
        for (let i = 0; i < octaves; i++) {
            total += this.noise3D(x * frequency, y * frequency, z * frequency) * amplitude;
            maxValue += amplitude;
            amplitude *= persistence;
            frequency *= lacunarity;
        }
        
        return total / maxValue;
    }
}

// Global noise generator instance
let noiseGen = null;

// ============================================================================
// BLOCK UTILITIES
// ============================================================================

/**
 * Build fast lookup tables from block data
 */
function buildBlockLookups() {
    idToProps = [];
    idToName = [];
    isTransparentById = [];
    blockTypeById = [];
    
    if (!BLOCK_TYPES) return;
    
    for (const [name, id] of Object.entries(BLOCK_TYPES)) {
        idToName[id] = name;
        const props = blockProperties[name] || { transparency: 1, color: { r: 1, g: 1, b: 1 } };
        idToProps[id] = props;
        isTransparentById[id] = (props.transparency ?? 1) < 1 || !!props.seeThrough;
        // Store block type from the data (defaults to "solid" if not specified)
        blockTypeById[id] = props.blockType || 'solid';
    }
}

/**
 * Get block properties by ID
 */
function getBlockProperties(blockId) {
    if (!blockId) return null;
    return idToProps[blockId] || { transparency: 1, color: { r: 1, g: 1, b: 1 } };
}

/**
 * Get block name from ID
 */
function getBlockName(blockId) {
    return idToName[blockId] || 'unknown';
}

/**
 * Check if a block is transparent
 */
function isTransparentBlock(blockProps) {
    if (!blockProps) return false;
    return (blockProps.transparency ?? 1) < 1 || blockProps.seeThrough === true;
}

/**
 * Get block type (mesh, structure, solid, etc.)
 */
function getBlockType(blockId) {
    return blockTypeById[blockId] || 'solid';
}

/**
 * Check if a block is a mesh-type block
 */
function isMeshBlock(blockId) {
    return getBlockType(blockId) === 'mesh';
}

// ============================================================================
// FACE CULLING SYSTEM
// ============================================================================

/**
 * Determine if a face should be culled (hidden)
 * 
 * Culling Rules:
 * 1. Unloaded chunks: Hide faces at boundaries
 * 2. Solid to Solid: Hide face
 * 3. Solid to Transparent: Show face
 * 4. Transparent to Same type: Hide face
 * 5. Transparent to Different: Show face
 * 6. Any to Air: Show face
 */
function shouldCullFace(blockType, neighborType, neighborChunkLoaded, blockProps, neighborProps) {
    // If neighbor chunk isn't loaded, cull the face
    if (!neighborChunkLoaded) {
        return true;
    }
    
    // If neighbor is air, show the face
    if (!neighborType || neighborType === 0) {
        return false;
    }
    
    // Get properties if not provided
    if (!blockProps) blockProps = getBlockProperties(blockType);
    if (!neighborProps) neighborProps = getBlockProperties(neighborType);
    
    if (!blockProps || !neighborProps) {
        return true; // Default to culled if no properties
    }
    
    const isCurrentTransparent = isTransparentBlock(blockProps);
    const isNeighborTransparent = isTransparentBlock(neighborProps);
    
    // Solid block rules
    if (!isCurrentTransparent) {
        // Solid to solid: cull
        if (!isNeighborTransparent) {
            return true;
        }
        // Solid to transparent: show
        return false;
    }
    
    // Transparent block rules
    if (isCurrentTransparent) {
        // Transparent to solid: show
        if (!isNeighborTransparent) {
            return false;
        }
        
        // Transparent to same type: cull
        if (blockType === neighborType) {
            return true;
        }
        
        // Transparent to different transparent: show
        return false;
    }
    
    return false; // Default: don't cull
}

// ============================================================================
// TERRAIN GENERATION
// ============================================================================

/**
 * Get terrain height at world coordinates using multi-octave noise
 */
function getTerrainHeight(worldX, worldZ) {
    if (!noiseGen) return SEA_LEVEL || 64;
    
    const scale = 0.005; // Base frequency
    
    // Continental noise - large scale features
    const continentalNoise = noiseGen.octaveNoise2D(
        worldX * scale * 0.3,
        worldZ * scale * 0.3,
        3, 0.5, 2.0, 1.0
    );
    
    // Regional noise - medium scale hills/valleys
    const regionalNoise = noiseGen.octaveNoise2D(
        worldX * scale,
        worldZ * scale,
        4, 0.5, 2.0, 1.0
    );
    
    // Local detail noise - fine detail
    const localNoise = noiseGen.octaveNoise2D(
        worldX * scale * 3.0,
        worldZ * scale * 3.0,
        5, 0.5, 2.0, 1.0
    );
    
    // Combine noise layers with different weights
    const baseHeight = SEA_LEVEL || 64;
    const height = baseHeight +
        continentalNoise * 40 +  // Large features: -40 to +40
        regionalNoise * 20 +      // Medium features: -20 to +20
        localNoise * 8;           // Fine detail: -8 to +8
    
    return Math.floor(height);
}

/**
 * Get 3D density for cave generation
 * Returns value between -1 and 1
 * Positive = solid, Negative = air (cave)
 */
function getCaveDensity(worldX, worldY, worldZ, baseTerrainHeight) {
    if (!noiseGen) return 1.0; // Solid by default
    
    const caveScale = 0.02;
    const caveThreshold = 0.3; // Values below this create caves
    
    const density = noiseGen.octaveNoise3D(
        worldX * caveScale,
        worldY * caveScale * 0.5, // Less vertical variation
        worldZ * caveScale,
        3, 0.5, 2.0, 1.0
    );
    
    // Make caves less common near surface
    const surfaceDepthFactor = Math.min(1.0, Math.max(0, (baseTerrainHeight - worldY) / 20));
    const adjustedDensity = density + (1.0 - surfaceDepthFactor) * 0.5;
    
    return adjustedDensity > caveThreshold ? 1.0 : -1.0;
}

/**
 * Determine block type at a given position
 */
function getBlockTypeAtPosition(worldX, worldY, worldZ, terrainHeight) {
    if (!BLOCK_TYPES) return 0;
    
    // Helper to get block ID with fallbacks
    const getBlockId = (name, fallback = 0) => {
        return BLOCK_TYPES[name] ?? BLOCK_TYPES[name.toUpperCase()] ?? BLOCK_TYPES[name.toLowerCase()] ?? fallback;
    };
    
    const stoneId = getBlockId('stone', 1);
    const dirtId = getBlockId('dirt', 2);
    const grassId = getBlockId('grass', 1);
    const sandId = getBlockId('sand', 6);
    const waterSurface = SEA_LEVEL || 64;
    
    // Above terrain height = air
    if (worldY > terrainHeight) {
        // Check if below water level
        if (worldY <= waterSurface) {
            return BLOCK_TYPES.water; // Water fills below sea level
        }
        return 0; // Air
    }
    
    // Check for caves
    if (worldY < terrainHeight - 3) { // Only check caves below surface layers
        const density = getCaveDensity(worldX, worldY, worldZ, terrainHeight);
        if (density < 0) {
            return 0; // Cave (air)
        }
    }
    
    // Surface block selection based on height and biome
    const depthBelowSurface = terrainHeight - worldY;
    
    if (depthBelowSurface === 0) {
        // Top block - depends on biome/height
        if (terrainHeight < waterSurface - 2) {
            return sandId; // Underwater = sand
        } else if (terrainHeight >= 100) {
            return stoneId; // Mountains = stone
        } else {
            return grassId; // Normal = grass
        }
    } else if (depthBelowSurface < 4) {
        // Subsurface layers (1-3 blocks deep)
        if (terrainHeight < waterSurface - 2) {
            return sandId;
        } else {
            return dirtId;
        }
    } else {
        // Deep underground = stone
        return stoneId;
    }
}

/**
 * Generate chunk data with procedural terrain
 */
function generateChunkData(cx, cz) {
    const data = new Array(CHUNK_SIZE);
    data.chunkX = cx;
    data.chunkZ = cz;
    
    const heightMap = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE);
    
    // Generate terrain for this chunk
    for (let x = 0; x < CHUNK_SIZE; x++) {
        data[x] = [];
        
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const worldX = cx * CHUNK_SIZE + x;
            const worldZ = cz * CHUNK_SIZE + z;
            
            // Get terrain height at this position
            const terrainHeight = getTerrainHeight(worldX, worldZ);
            const clampedHeight = Math.max(0, Math.min(terrainHeight, WORLD_HEIGHT - 1));
            
            heightMap[z * CHUNK_SIZE + x] = clampedHeight;
            
            // Generate vertical column
            for (let y = 0; y <= clampedHeight && y < WORLD_HEIGHT; y++) {
                if (!data[x][y]) data[x][y] = [];
                
                const blockType = getBlockTypeAtPosition(worldX, y, worldZ, clampedHeight);
                data[x][y][z] = blockType;
            }
        }
    }
    
    data.heightMap = heightMap;
    
    // Store in this worker's chunk storage
    const key = `${cx},${cz}`;
    chunkStorage.set(key, data);
    
    return data;
}

// ============================================================================
// GEOMETRY BUILDING
// ============================================================================

// Cube face definitions
const faces = [
    { dir: [0, 0, 1], vertices: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },  // Front
    { dir: [0, 0, -1], vertices: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }, // Back
    { dir: [1, 0, 0], vertices: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },  // Right
    { dir: [-1, 0, 0], vertices: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // Left
    { dir: [0, 1, 0], vertices: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },  // Top
    { dir: [0, -1, 0], vertices: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }  // Bottom
];

const faceNames = ['front', 'back', 'right', 'left', 'top', 'bottom'];

/**
 * Get neighbor chunk from cache or storage
 */
function getNeighborChunk(cx, cz) {
    const key = `${cx},${cz}`;
    return chunkStorage.get(key) || neighborChunkCache.get(key);
}

/**
 * Get block at position, checking neighboring chunks if needed
 */
function getBlockAt(chunkData, cx, cz, x, y, z, neighborCache) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    
    if (x < 0) {
        if (!neighborCache.left) return 0;
        const ncol = neighborCache.left[CHUNK_SIZE - 1];
        return (ncol && ncol[y] && ncol[y][z]) || 0;
    } else if (x >= CHUNK_SIZE) {
        if (!neighborCache.right) return 0;
        const ncol = neighborCache.right[0];
        return (ncol && ncol[y] && ncol[y][z]) || 0;
    } else if (z < 0) {
        if (!neighborCache.back) return 0;
        const ncol = neighborCache.back[x];
        return (ncol && ncol[y] && ncol[y][CHUNK_SIZE - 1]) || 0;
    } else if (z >= CHUNK_SIZE) {
        if (!neighborCache.front) return 0;
        const ncol = neighborCache.front[x];
        return (ncol && ncol[y] && ncol[y][0]) || 0;
    } else {
        const col = chunkData[x];
        return (col && col[y] && col[y][z]) || 0;
    }
}

/**
 * Get the height of mesh terrain at a specific column
 * Returns the Y coordinate of the top mesh block
 */
function getMeshHeight(chunkData, cx, cz, x, z, neighborCache) {
    // Start from heightMap if available
    let startY = WORLD_HEIGHT - 1;
    if (chunkData.heightMap && x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
        startY = chunkData.heightMap[z * CHUNK_SIZE + x];
    }
    
    // Scan down to find the topmost mesh block
    for (let y = startY; y >= 0; y--) {
        const blockId = getBlockAt(chunkData, cx, cz, x, y, z, neighborCache);
        if (blockId && isMeshBlock(blockId)) {
            return y;
        }
    }
    
    return -1; // No mesh block found
}

/**
 * Generate smooth mesh surface for terrain
 * Uses height interpolation at block corners to create sloped polygons
 */
function buildMeshSurface(chunkData, cx, cz, neighborCache) {
    // Group mesh quads by blockName so each can use its own texture/material
    const groups = new Map(); // blockName -> { vertices, uvs, indices, normals, vertexCount }

    const worldX = cx * CHUNK_SIZE;
    const worldZ = cz * CHUNK_SIZE;

    // Helper: robust corner sampler with fallback when neighbor chunk isn't available
    function sampleCornerHeight(lx, lz) {
        // Try direct sampling (supports out-of-range via neighborCache in getBlockAt)
        let h = getMeshHeight(chunkData, cx, cz, lx, lz, neighborCache);
        if (h >= 0) return h;
        // Fallback: clamp to current chunk boundary and try again
        const clampedX = Math.max(0, Math.min(CHUNK_SIZE - 1, lx));
        const clampedZ = Math.max(0, Math.min(CHUNK_SIZE - 1, lz));
        h = getMeshHeight(chunkData, cx, cz, clampedX, clampedZ, neighborCache);
        return h; // may still be -1 if no mesh found in this column
    }

    // Iterate over each horizontal position in the chunk
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            // Get heights at the 4 corners of this cell
            const h00 = sampleCornerHeight(x, z);
            const h10 = sampleCornerHeight(x + 1, z);
            const h01 = sampleCornerHeight(x, z + 1);
            const h11 = sampleCornerHeight(x + 1, z + 1);

            // If still no valid heights, skip
            if (h00 < 0 && h10 < 0 && h01 < 0 && h11 < 0) continue;

            // If some corners missing, fill using nearest available heights to avoid holes at edges
            const heights = [h00, h10, h01, h11];
            // Replace -1 with nearest neighbor among corners
            for (let i = 0; i < 4; i++) {
                if (heights[i] < 0) {
                    // Prefer adjacent: for i=0 use i=1 or 2; i=1 use 0 or 3; i=2 use 0 or 3; i=3 use 1 or 2
                    const candidates = (
                        i === 0 ? [1, 2, 3] :
                        i === 1 ? [0, 3, 2] :
                        i === 2 ? [0, 3, 1] : [1, 2, 0]
                    );
                    let rep = -1;
                    for (const c of candidates) { if (heights[c] >= 0) { rep = heights[c]; break; } }
                    heights[i] = rep >= 0 ? rep : 0; // final fallback to 0 to keep mesh closed
                }
            }
            const [HH00, HH10, HH01, HH11] = heights;

            // Heights of the surface (place on top of blocks)
            const height00 = HH00 + 1;
            const height10 = HH10 + 1;
            const height01 = HH01 + 1;
            const height11 = HH11 + 1;

            // Choose block by majority of the four corner blocks (affects all neighbors), tie-break by highest
            const cornerSamples = [
                { x, z, y: HH00, id: getBlockAt(chunkData, cx, cz, x, HH00, z, neighborCache) },
                { x: x + 1, z, y: HH10, id: getBlockAt(chunkData, cx, cz, x + 1, HH10, z, neighborCache) },
                { x, z: z + 1, y: HH01, id: getBlockAt(chunkData, cx, cz, x, HH01, z + 1, neighborCache) },
                { x: x + 1, z: z + 1, y: HH11, id: getBlockAt(chunkData, cx, cz, x + 1, HH11, z + 1, neighborCache) }
            ];
            const freq = new Map();
            for (const s of cornerSamples) {
                if (s.id && isMeshBlock(s.id)) freq.set(s.id, (freq.get(s.id) || 0) + 1);
            }
            let blockId = 0;
            if (freq.size > 0) {
                blockId = Array.from(freq.entries()).sort((a, b) => b[1] - a[1])[0][0];
            } else {
                // Fallback to highest corner's block
                let pick = cornerSamples[0];
                for (const s of cornerSamples) { if (s.y >= pick.y) pick = s; }
                blockId = pick.id || 0;
            }
            if (!blockId) continue;
            const blockName = getBlockName(blockId);

            // Get or create group for this blockName
            if (!groups.has(blockName)) {
                groups.set(blockName, { vertices: [], uvs: [], indices: [], normals: [], vertexCount: 0, blockName });
            }
            const geo = groups.get(blockName);

            // Build 4 unique vertices of the quad in CCW order when viewed from above
            // v0: (x, z)     -> (0,0)
            // v1: (x, z+1)   -> (0,1)
            // v2: (x+1, z+1) -> (1,1)
            // v3: (x+1, z)   -> (1,0)
            const v0 = [worldX + x,     height00, worldZ + z];
            const v1 = [worldX + x,     height01, worldZ + z + 1];
            const v2 = [worldX + x + 1, height11, worldZ + z + 1];
            const v3 = [worldX + x + 1, height10, worldZ + z];

            geo.vertices.push(...v0, ...v1, ...v2, ...v3);
            geo.uvs.push(
                0, 0,
                0, 1,
                1, 1,
                1, 0
            );

            // Indices for two triangles: (0,1,2) and (0,2,3)
            geo.indices.push(
                geo.vertexCount, geo.vertexCount + 1, geo.vertexCount + 2,
                geo.vertexCount, geo.vertexCount + 2, geo.vertexCount + 3
            );

            // Compute a face normal (same for all 4 verts)
            const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
            const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            const nlen = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
            nx /= nlen; ny /= nlen; nz /= nlen;
            for (let i = 0; i < 4; i++) geo.normals.push(nx, ny, nz);

            geo.vertexCount += 4;
        }
    }

    // Convert groups to textured entries expected by main thread
    const entries = [];
    for (const [name, geo] of groups.entries()) {
        const IdxArray = (geo.vertexCount <= 65535) ? Uint16Array : Uint32Array;
        entries.push({
            key: `${name}_mesh_top`,
            blockName: name,
            faceName: 'top', // Prefer top texture if available
            vertices: new Float32Array(geo.vertices),
            indices: new IdxArray(geo.indices),
            uvs: new Float32Array(geo.uvs),
            normals: new Float32Array(geo.normals),
            color: { r: 1, g: 1, b: 1 }
        });
    }

    return entries;
}

/**
 * Build geometry for a chunk
 * Returns typed arrays ready for transfer
 */
function buildChunkGeometry(chunkData, cx, cz) {
    const texturedGeometries = {};
    const oVertices = [], oIndices = [], oUVs = [], oColors = [], oNormals = [];
    let oVertexCount = 0;
    const tVertices = [], tIndices = [], tUVs = [], tColors = [], tNormals = [];
    let tVertexCount = 0;
    
    // Pre-cache neighboring chunks
    const neighborChunkCache = {
        left: getNeighborChunk(cx - 1, cz),
        right: getNeighborChunk(cx + 1, cz),
        front: getNeighborChunk(cx, cz + 1),
        back: getNeighborChunk(cx, cz - 1)
    };
    
    const { heightMap } = chunkData;
    
    // Build mesh surface geometry for smooth terrain (as textured entries)
    const meshTexturedEntries = buildMeshSurface(chunkData, cx, cz, neighborChunkCache);
    
    for (let x = 0; x < CHUNK_SIZE; x++) {
        const col = chunkData[x];
        if (!col) continue;
        
        for (let z = 0; z < CHUNK_SIZE; z++) {
            // Determine max Y for this column
            let topY;
            if (heightMap) {
                topY = heightMap[z * CHUNK_SIZE + x];
            } else {
                topY = -1;
                for (let ty = WORLD_HEIGHT - 1; ty >= 0; ty--) {
                    const r = col[ty];
                    if (r && r[z]) { topY = ty; break; }
                }
            }
            if (topY < 0) continue;
            
            for (let y = 0; y <= topY; y++) {
                const row = col[y];
                if (!row) continue;
                const blockType = row[z] || 0;
                if (blockType === 0) continue;
                
                // Skip mesh blocks - they're already rendered as smooth surfaces
                if (isMeshBlock(blockType)) continue;
                
                const blockName = getBlockName(blockType);
                const blockProps = getBlockProperties(blockType);
                
                // Process each face
                for (let f = 0; f < faces.length; f++) {
                    const face = faces[f];
                    const faceName = faceNames[f];
                    const nx = x + face.dir[0];
                    const ny = y + face.dir[1];
                    const nz = z + face.dir[2];
                    
                    // Check neighbor
                    let neighbor = 0;
                    let isNeighborChunkLoaded = true;
                    
                    if (ny < 0 || ny >= WORLD_HEIGHT) {
                        neighbor = 0;
                    } else if (nx < 0) {
                        if (neighborChunkCache.left) {
                            const ncol = neighborChunkCache.left[CHUNK_SIZE - 1];
                            neighbor = (ncol && ncol[ny] && ncol[ny][nz]) || 0;
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else if (nx >= CHUNK_SIZE) {
                        if (neighborChunkCache.right) {
                            const ncol = neighborChunkCache.right[0];
                            neighbor = (ncol && ncol[ny] && ncol[ny][nz]) || 0;
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else if (nz < 0) {
                        if (neighborChunkCache.back) {
                            const ncol = neighborChunkCache.back[nx];
                            neighbor = (ncol && ncol[ny] && ncol[ny][CHUNK_SIZE - 1]) || 0;
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else if (nz >= CHUNK_SIZE) {
                        if (neighborChunkCache.front) {
                            const ncol = neighborChunkCache.front[nx];
                            neighbor = (ncol && ncol[ny] && ncol[ny][0]) || 0;
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else {
                        const ncol = chunkData[nx];
                        neighbor = (ncol && ncol[ny] && ncol[ny][nz]) || 0;
                    }
                    
                    const neighborProps = neighbor ? getBlockProperties(neighbor) : null;
                    
                    // Check if face should be culled
                    if (shouldCullFace(blockType, neighbor, isNeighborChunkLoaded, blockProps, neighborProps)) {
                        continue;
                    }
                    
                    // Check for textures
                    const hasFaceTexture = blockProps.faces && blockProps.faces[faceName] && blockProps.faces[faceName].hasTexture;
                    const hasDefaultTexture = blockProps.hasDefaultTexture;
                    
                    if (hasFaceTexture || hasDefaultTexture) {
                        // Textured geometry
                        const textureKey = blockName + (hasFaceTexture ? '_' + faceName : '');
                        if (!texturedGeometries[textureKey]) {
                            texturedGeometries[textureKey] = {
                                vertices: [],
                                indices: [],
                                uvs: [],
                                normals: [],
                                vertexCount: 0,
                                blockName: blockName,
                                faceName: hasFaceTexture ? faceName : null,
                                color: blockProps.color || { r: 1, g: 1, b: 1 }
                            };
                        }
                        
                        const geo = texturedGeometries[textureKey];
                        const [nxn, nyn, nzn] = face.dir;
                        
                        for (let i = 0; i < 4; i++) {
                            const v = face.vertices[i];
                            geo.vertices.push(
                                cx * CHUNK_SIZE + x + v[0],
                                y + v[1],
                                cz * CHUNK_SIZE + z + v[2]
                            );
                            geo.normals.push(nxn, nyn, nzn);
                        }
                        
                        geo.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
                        geo.indices.push(
                            geo.vertexCount, geo.vertexCount + 1, geo.vertexCount + 2,
                            geo.vertexCount, geo.vertexCount + 2, geo.vertexCount + 3
                        );
                        geo.vertexCount += 4;
                    } else {
                        // Non-textured geometry
                        const baseColor = blockProps.color || { r: 1, g: 1, b: 1 };
                        const [nxn, nyn, nzn] = face.dir;
                        
                        if (blockProps.transparency === 1) {
                            // Opaque
                            for (let i = 0; i < 4; i++) {
                                const v = face.vertices[i];
                                oVertices.push(
                                    cx * CHUNK_SIZE + x + v[0],
                                    y + v[1],
                                    cz * CHUNK_SIZE + z + v[2]
                                );
                                oColors.push(baseColor.r, baseColor.g, baseColor.b);
                                oNormals.push(nxn, nyn, nzn);
                            }
                            oUVs.push(0, 0, 1, 0, 1, 1, 0, 1);
                            oIndices.push(
                                oVertexCount, oVertexCount + 1, oVertexCount + 2,
                                oVertexCount, oVertexCount + 2, oVertexCount + 3
                            );
                            oVertexCount += 4;
                        } else {
                            // Transparent
                            for (let i = 0; i < 4; i++) {
                                const v = face.vertices[i];
                                tVertices.push(
                                    cx * CHUNK_SIZE + x + v[0],
                                    y + v[1],
                                    cz * CHUNK_SIZE + z + v[2]
                                );
                                tColors.push(baseColor.r, baseColor.g, baseColor.b);
                                tNormals.push(nxn, nyn, nzn);
                            }
                            tUVs.push(0, 0, 1, 0, 1, 1, 0, 1);
                            tIndices.push(
                                tVertexCount, tVertexCount + 1, tVertexCount + 2,
                                tVertexCount, tVertexCount + 2, tVertexCount + 3
                            );
                            tVertexCount += 4;
                        }
                    }
                }
            }
        }
    }
    
    // Create typed arrays for efficient transfer
    const OIdxArray = (oVertexCount <= 65535) ? Uint16Array : Uint32Array;
    const TIdxArray = (tVertexCount <= 65535) ? Uint16Array : Uint32Array;
    
    const geometryData = {
        opaque: {
            vertices: new Float32Array(oVertices),
            indices: new OIdxArray(oIndices),
            uvs: new Float32Array(oUVs),
            colors: new Float32Array(oColors),
            normals: new Float32Array(oNormals)
        },
        transparent: {
            vertices: new Float32Array(tVertices),
            indices: new TIdxArray(tIndices),
            uvs: new Float32Array(tUVs),
            colors: new Float32Array(tColors),
            normals: new Float32Array(tNormals)
        },
        textured: []
    };
    
    // Convert textured geometries
    for (const [key, geo] of Object.entries(texturedGeometries)) {
        const IdxArray = (geo.vertexCount <= 65535) ? Uint16Array : Uint32Array;
        geometryData.textured.push({
            key: key,
            vertices: new Float32Array(geo.vertices),
            indices: new IdxArray(geo.indices),
            uvs: new Float32Array(geo.uvs),
            normals: new Float32Array(geo.normals),
            blockName: geo.blockName,
            faceName: geo.faceName,
            color: geo.color
        });
    }
    // Append mesh textured entries
    if (meshTexturedEntries && meshTexturedEntries.length) {
        for (const entry of meshTexturedEntries) {
            geometryData.textured.push(entry);
        }
    }
    
    return geometryData;
}

/**
 * Get all transferable buffers from geometry data
 */
function getTransferableBuffers(geometryData) {
    const buffers = [
        geometryData.opaque.vertices.buffer,
        geometryData.opaque.indices.buffer,
        geometryData.opaque.uvs.buffer,
        geometryData.opaque.colors.buffer,
        geometryData.opaque.normals.buffer,
        geometryData.transparent.vertices.buffer,
        geometryData.transparent.indices.buffer,
        geometryData.transparent.uvs.buffer,
        geometryData.transparent.colors.buffer,
        geometryData.transparent.normals.buffer
    ];
    
    for (const tex of geometryData.textured) {
        buffers.push(tex.vertices.buffer);
        buffers.push(tex.indices.buffer);
        buffers.push(tex.uvs.buffer);
        buffers.push(tex.normals.buffer);
    }
    
    return buffers;
}

/**
 * Detect which borders of a chunk changed (for neighbor updates)
 */
function getChangedBorders(oldChunk, newChunk) {
    const result = { left: false, right: false, back: false, front: false };
    
    if (!oldChunk || !newChunk) {
        // Conservative: update all neighbors
        return { left: true, right: true, back: true, front: true };
    }
    
    // Check left border (x=0)
    for (let y = 0; y < WORLD_HEIGHT && !result.left; y++) {
        const rOld = oldChunk[0] && oldChunk[0][y];
        const rNew = newChunk[0] && newChunk[0][y];
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const a = rOld ? (rOld[z] || 0) : 0;
            const b = rNew ? (rNew[z] || 0) : 0;
            if (a !== b) { result.left = true; break; }
        }
    }
    
    // Check right border (x=CHUNK_SIZE-1)
    const rx = CHUNK_SIZE - 1;
    for (let y = 0; y < WORLD_HEIGHT && !result.right; y++) {
        const rOld = oldChunk[rx] && oldChunk[rx][y];
        const rNew = newChunk[rx] && newChunk[rx][y];
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const a = rOld ? (rOld[z] || 0) : 0;
            const b = rNew ? (rNew[z] || 0) : 0;
            if (a !== b) { result.right = true; break; }
        }
    }
    
    // Check back border (z=0)
    for (let y = 0; y < WORLD_HEIGHT && !result.back; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const rOld = oldChunk[x] && oldChunk[x][y];
            const rNew = newChunk[x] && newChunk[x][y];
            const a = rOld ? (rOld[0] || 0) : 0;
            const b = rNew ? (rNew[0] || 0) : 0;
            if (a !== b) { result.back = true; break; }
        }
    }
    
    // Check front border (z=CHUNK_SIZE-1)
    const fz = CHUNK_SIZE - 1;
    for (let y = 0; y < WORLD_HEIGHT && !result.front; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const rOld = oldChunk[x] && oldChunk[x][y];
            const rNew = newChunk[x] && newChunk[x][y];
            const a = rOld ? (rOld[fz] || 0) : 0;
            const b = rNew ? (rNew[fz] || 0) : 0;
            if (a !== b) { result.front = true; break; }
        }
    }
    
    return result;
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

self.onmessage = function(e) {
    const { type, cx, cz, constants, modifiedChunk, requestGeometry, neighbors, seed } = e.data;
    
    // Handle initialization
    if (type === 'init' && constants) {
        CHUNK_SIZE = constants.CHUNK_SIZE;
        WORLD_HEIGHT = constants.WORLD_HEIGHT;
        BLOCK_TYPES = constants.BLOCK_TYPES;
        SEA_LEVEL = constants.SEA_LEVEL || 64;
        blockProperties = constants.blockColors || {};
        worldSeed = seed || constants.seed || 'DefaultSeed';
        
        // Initialize noise generator with seed
        noiseGen = new NoiseGenerator(worldSeed);
        
        buildBlockLookups();
        
        self.postMessage({ type: 'initialized' });
        return;
    }
    
    // Handle chunk updates (block modifications)
    if (type === 'updateChunk') {
        // Cache neighbor data if provided
        if (neighbors) {
            if (neighbors.left) neighborChunkCache.set(`${cx - 1},${cz}`, neighbors.left);
            if (neighbors.right) neighborChunkCache.set(`${cx + 1},${cz}`, neighbors.right);
            if (neighbors.back) neighborChunkCache.set(`${cx},${cz - 1}`, neighbors.back);
            if (neighbors.front) neighborChunkCache.set(`${cx},${cz + 1}`, neighbors.front);
        }
        
        const key = `${cx},${cz}`;
        const oldChunk = chunkStorage.get(key);
        const bordersChanged = getChangedBorders(oldChunk, modifiedChunk);
        
        // Store modified chunk
        chunkStorage.set(key, modifiedChunk);
        
        // Update modified chunk geometry
        const geometryData = buildChunkGeometry(modifiedChunk, cx, cz);
        self.postMessage({
            type: 'chunkUpdated',
            cx,
            cz,
            geometryData
        }, getTransferableBuffers(geometryData));
        
        // Update affected neighbors
        if (bordersChanged.left) {
            const nChunk = chunkStorage.get(`${cx - 1},${cz}`);
            if (nChunk) {
                const geom = buildChunkGeometry(nChunk, cx - 1, cz);
                self.postMessage({ type: 'chunkUpdated', cx: cx - 1, cz, geometryData: geom }, getTransferableBuffers(geom));
            }
        }
        if (bordersChanged.right) {
            const nChunk = chunkStorage.get(`${cx + 1},${cz}`);
            if (nChunk) {
                const geom = buildChunkGeometry(nChunk, cx + 1, cz);
                self.postMessage({ type: 'chunkUpdated', cx: cx + 1, cz, geometryData: geom }, getTransferableBuffers(geom));
            }
        }
        if (bordersChanged.back) {
            const nChunk = chunkStorage.get(`${cx},${cz - 1}`);
            if (nChunk) {
                const geom = buildChunkGeometry(nChunk, cx, cz - 1);
                self.postMessage({ type: 'chunkUpdated', cx, cz: cz - 1, geometryData: geom }, getTransferableBuffers(geom));
            }
        }
        if (bordersChanged.front) {
            const nChunk = chunkStorage.get(`${cx},${cz + 1}`);
            if (nChunk) {
                const geom = buildChunkGeometry(nChunk, cx, cz + 1);
                self.postMessage({ type: 'chunkUpdated', cx, cz: cz + 1, geometryData: geom }, getTransferableBuffers(geom));
            }
        }
        
        return;
    }
    
    // Backwards compatibility: accept constants inline
    if (constants && !CHUNK_SIZE) {
        CHUNK_SIZE = constants.CHUNK_SIZE;
        WORLD_HEIGHT = constants.WORLD_HEIGHT;
        BLOCK_TYPES = constants.BLOCK_TYPES;
        SEA_LEVEL = constants.SEA_LEVEL || 64;
        blockProperties = constants.blockColors || {};
        worldSeed = seed || constants.seed || 'DefaultSeed';
        noiseGen = new NoiseGenerator(worldSeed);
        buildBlockLookups();
    }
    
    // Generate or retrieve chunk
    const key = `${cx},${cz}`;
    let chunkData = chunkStorage.get(key);
    
    if (!chunkData) {
        // Generate new chunk
        chunkData = generateChunkData(cx, cz);
        
        // Build geometry
        const geometryData = buildChunkGeometry(chunkData, cx, cz);
        
        // Send chunk data and geometry
        self.postMessage({
            cx,
            cz,
            chunkData,
            geometryData
        }, getTransferableBuffers(geometryData));
        
        // Update neighbors that might need re-rendering
        const neighbors = [
            [cx - 1, cz], [cx + 1, cz],
            [cx, cz - 1], [cx, cz + 1]
        ];
        
        for (const [ncx, ncz] of neighbors) {
            const nKey = `${ncx},${ncz}`;
            if (chunkStorage.has(nKey)) {
                const neighborData = chunkStorage.get(nKey);
                const neighborGeom = buildChunkGeometry(neighborData, ncx, ncz);
                
                self.postMessage({
                    type: 'chunkUpdated',
                    cx: ncx,
                    cz: ncz,
                    geometryData: neighborGeom
                }, getTransferableBuffers(neighborGeom));
            }
        }
        
        return;
    }
    
    // Chunk exists, handle geometry request
    if (requestGeometry) {
        // Cache neighbor data if provided
        if (neighbors) {
            if (neighbors.left) neighborChunkCache.set(`${cx - 1},${cz}`, neighbors.left);
            if (neighbors.right) neighborChunkCache.set(`${cx + 1},${cz}`, neighbors.right);
            if (neighbors.back) neighborChunkCache.set(`${cx},${cz - 1}`, neighbors.back);
            if (neighbors.front) neighborChunkCache.set(`${cx},${cz + 1}`, neighbors.front);
        }
        
        const geometryData = buildChunkGeometry(chunkData, cx, cz);
        
        self.postMessage({
            cx,
            cz,
            geometryData
        }, getTransferableBuffers(geometryData));
    } else {
        // Legacy: just send chunk data
        self.postMessage({ cx, cz, chunkData });
    }
};
