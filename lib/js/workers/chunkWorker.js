// Chunk Worker - Multinoise terrain generation (biome-aware)
// Note: We'll receive needed variables and constants from the main thread

let CHUNK_SIZE, WORLD_HEIGHT, BLOCK_TYPES, BIOMES, worldSeed, StructureGenerators;
let blockColors; // Will be populated from main thread

// Advanced terrain system constants (mirrored from main thread)
let BIOME_ADJACENCY, GEOLOGICAL_FORMATIONS, TERRAIN_BOUNDS, NOISE_CONFIG;
let AdvancedNoiseGenerator;

// Add chunk storage
const chunkStorage = new Map();
const neighborChunks = new Map(); // Store neighboring chunks for proper culling

// ===== MULTINOISE SYSTEM (WORKER VERSION) =====

// Utilities
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function invLerp(a, b, v) { return (v - a) / (b - a); }
function lerp(a, b, t) { return a + (b - a) * t; }

// Copy of seededRandomGenerator is defined later (keep for ImprovedNoise); no changes.

// Multi-noise sampler for five fields: continentalness, erosion, peaksValleys, temperature, humidity
// All outputs normalized in [0,1]. Deterministic per worldSeed.
class MultiNoiseSampler {
    constructor(seed, useAdvanced = true) {
        this.seed = seed;
        this.noiseGen = new ImprovedNoise();
        this.adv = AdvancedNoiseGenerator ? new AdvancedNoiseGenerator(seed) : null;
        this.useAdvanced = useAdvanced && !!this.adv;
        // Default configs if not provided by NOISE_CONFIG
        this.config = {
            continentalness: { frequency: 0.0008, amplitude: 1, octaves: 4 },
            erosion: { frequency: 0.0025, amplitude: 1, octaves: 4 },
            peaksValleys: { frequency: 0.0035, amplitude: 1, octaves: 4, ridged: true },
            temperature: { frequency: 0.0009, amplitude: 1, octaves: 3, warp: 120 },
            humidity: { frequency: 0.0011, amplitude: 1, octaves: 3, warp: 120 }
        };
        // Allow overrides from NOISE_CONFIG if present
        if (NOISE_CONFIG && NOISE_CONFIG.multinoise) {
            this.config = Object.assign(this.config, NOISE_CONFIG.multinoise);
        }
    }

    // Basic octaved noise in [-1,1]
    _octave(x, z, cfg) {
        let value = 0, amp = cfg.amplitude || 1, freq = cfg.frequency || 1, max = 0;
        const oct = cfg.octaves || 1;
        for (let i = 0; i < oct; i++) {
            value += this.noiseGen.noise(x * freq, 0, z * freq) * amp;
            max += amp; amp *= 0.5; freq *= 2.0;
        }
        return max > 0 ? value / max : 0;
    }

    // Ridged variant in [0,1]
    _ridged(x, z, cfg) {
        if (this.useAdvanced) {
            return clamp01(this.adv.ridgedNoise(x, z, {
                frequency: cfg.frequency || 1,
                amplitude: 1,
                octaves: cfg.octaves || 4
            }));
        }
        // Fallback implementation
        let value = 0, amp = 1, freq = cfg.frequency || 1;
        for (let i = 0; i < (cfg.octaves || 4); i++) {
            let n = Math.abs(this.noiseGen.noise(x * freq, 0, z * freq));
            n = 1 - n; n = n * n; // sharper ridges
            value += n * amp; amp *= 0.5; freq *= 2.0;
        }
        return clamp01(value);
    }

    // Domain warped [-1,1]
    _warped(x, z, cfg, warpStrength) {
        if (this.useAdvanced) {
            return this.adv.domainWarpedNoise(x, z, {
                frequency: cfg.frequency || 1,
                amplitude: 1,
                octaves: cfg.octaves || 3
            }, warpStrength || 80);
        }
        const ws = warpStrength || 80;
        const wx = this.noiseGen.noise(x * 0.01, 0, z * 0.01) * ws;
        const wz = this.noiseGen.noise(x * 0.01, 100, z * 0.01) * ws;
        return this._octave(x + wx, z + wz, cfg);
    }

    // Sample all fields at world (x,z) -> {c,e,pv,t,h} in [0,1]
    sample(x, z) {
        const c = (this._octave(x, z, this.config.continentalness) * 0.5 + 0.5);
        const e = (this._octave(x, z, this.config.erosion) * 0.5 + 0.5);
        const pv = (this.config.peaksValleys.ridged ? this._ridged(x, z, this.config.peaksValleys)
                                                    : (this._octave(x, z, this.config.peaksValleys) * 0.5 + 0.5));
        const t = clamp01((this._warped(x, z, this.config.temperature, this.config.temperature.warp) * 0.5 + 0.5));
        const h = clamp01((this._warped(x, z, this.config.humidity, this.config.humidity.warp) * 0.5 + 0.5));
        return { c, e, pv, t, h };
    }

    // Precompute arrays for a chunk; returns object of Float32Arrays length CHUNK_SIZE*CHUNK_SIZE
    precomputeChunk(cx, cz, CHUNK_SIZE) {
        const size = CHUNK_SIZE * CHUNK_SIZE;
        const out = {
            c: new Float32Array(size),
            e: new Float32Array(size),
            pv: new Float32Array(size),
            t: new Float32Array(size),
            h: new Float32Array(size)
        };
        let idx = 0;
        const baseX = cx * CHUNK_SIZE;
        const baseZ = cz * CHUNK_SIZE;
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let x = 0; x < CHUNK_SIZE; x++, idx++) {
                const wx = baseX + x, wz = baseZ + z;
                const s = this.sample(wx, wz);
                out.c[idx] = s.c; out.e[idx] = s.e; out.pv[idx] = s.pv; out.t[idx] = s.t; out.h[idx] = s.h;
            }
        }
        return out;
    }
}

// Biome assignment with smooth blending in temperature/humidity space
class BiomeAssigner {
    constructor(biomes) {
        // Support both { biomes: {...} } and direct map
        this.biomes = (biomes && biomes.biomes) ? biomes.biomes : biomes || {};
        this.biomeList = Object.keys(this.biomes);
        // Pre-normalize target points into [0,1] temp/hum space
        this.targets = this.biomeList.map(name => {
            const b = this.biomes[name] || {};
            // Temperature/humidity in JSON appear to be Fahrenheit and percentage (0-100)
            const t = clamp01((b.temperature != null ? b.temperature : 70) / 100);
            const h = clamp01((b.humidity != null ? b.humidity : 50) / 100);
            return { name, t, h };
        });
    }

    // Returns {primary, secondary, blend, params}
    pick(t, h) {
        if (this.targets.length === 0) {
            return { primary: 'grassland', secondary: null, blend: 0, params: { baseHeight: 64, heightVariation: 2 } };
        }
        // Find two closest biomes by Euclidean distance
        let best1 = null, best2 = null;
        for (const target of this.targets) {
            const dt = t - target.t; const dh = h - target.h; const d = dt*dt + dh*dh;
            if (!best1 || d < best1.d) { best2 = best1; best1 = { t: target, d }; }
            else if (!best2 || d < best2.d) { best2 = { t: target, d }; }
        }
        let primary = best1.t.name;
        let secondary = best2 ? best2.t.name : null;
        // Convert distances to a soft blend factor
        let blend = 0;
        if (best2) {
            const d1 = Math.sqrt(best1.d), d2 = Math.sqrt(best2.d);
            const sum = d1 + d2 + 1e-6;
            blend = clamp01(d2 / sum); // farther second -> smaller blend
        }
        const bp = this.biomes[primary] || {};
        const sp = secondary ? (this.biomes[secondary] || {}) : null;
        // Interpolate core terrain params for smoother transitions
        const baseHeight = sp ? lerp((bp.baseHeight||64), (sp.baseHeight||64), blend) : (bp.baseHeight||64);
        const heightVariation = sp ? lerp((bp.heightVariation||0), (sp.heightVariation||0), blend) : (bp.heightVariation||0);
        return { primary, secondary, blend, params: { baseHeight, heightVariation } };
    }
}

// Terrain shaping using multi-noise fields
class TerrainShaper {
    constructor(bounds, seaLevel) {
        this.bounds = bounds || { min_elevation: 0, max_elevation: WORLD_HEIGHT-1 };
        this.seaLevel = seaLevel != null ? seaLevel : (this.bounds.sea_level != null ? this.bounds.sea_level : 50);
        // Elevation range we'll map to
        this.minElev = this.bounds.min_elevation != null ? this.bounds.min_elevation : 0;
        this.maxElev = this.bounds.max_elevation != null ? this.bounds.max_elevation : WORLD_HEIGHT-1;

        // Tunable shaping parameters (can be overridden via NOISE_CONFIG.terrainShaper)
        const tsCfg = (NOISE_CONFIG && NOISE_CONFIG.terrainShaper) ? NOISE_CONFIG.terrainShaper : {};
        // How strong mountains can get (higher -> taller peaks)
        this.mountainScale = tsCfg.mountainScale != null ? tsCfg.mountainScale : 130; // was ~90
        // Sharpen peaks/valleys by biasing pv in [0,1] ( >1 increases extremes )
        this.pvExponent = tsCfg.pvExponent != null ? tsCfg.pvExponent : 1.35;
        // Minimum erosion damping (higher min -> less overall erosion smoothing)
        this.erosionMin = tsCfg.erosionMin != null ? tsCfg.erosionMin : 0.6; // was ~0.25
        // How much erosion influences amplitude (0..1). Lower -> weaker erosion effect
        this.erosionWeight = tsCfg.erosionWeight != null ? tsCfg.erosionWeight : 0.4; // was ~0.75
        // Continentalness baseline span below/above sea level
        this.baseSpanBelow = tsCfg.baseSpanBelow != null ? tsCfg.baseSpanBelow : 35;  // was ~30
        this.baseSpanAbove = tsCfg.baseSpanAbove != null ? tsCfg.baseSpanAbove : 100; // was ~80
    }

    // Compute elevation using: continentalness -> landmass, peaksValleys -> mountains, erosion -> smoothness
    elevation(fields, biomeParams) {
        const { c, e, pv } = fields; // [0,1]
        // Landmass baseline: remap continentalness so 0.5 is near shore
        // Lower c -> deep ocean, higher c -> inland
        const base = lerp(this.seaLevel - this.baseSpanBelow, this.seaLevel + this.baseSpanAbove, c);
        // Sharpen peaks/valleys to accentuate extremes
        const pvShaped = Math.pow(clamp01(pv), this.pvExponent);
        // Mountain amplitude controlled by peaks/valleys, reduced by erosion (higher erosion -> smoother lower heights)
        // We reduce erosion influence and raise the minimum so terrain remains bold even in high-erosion areas
        const erosionFactor = this.erosionMin + this.erosionWeight * (1 - e); // range ~[erosionMin, erosionMin+erosionWeight]
        const mountain = pvShaped * this.mountainScale * erosionFactor;
        // Biome variation
        const biomeVar = (biomeParams.heightVariation || 0);
        const elev = base + mountain + biomeVar * (pv*2-1);
        return Math.max(this.minElev, Math.min(this.maxElev, elev));
    }
}

// Define cube faces for geometry creation
const faces = [
    // Front face
    { 
        dir: [0, 0, 1], 
        vertices: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    },
    // Back face
    { 
        dir: [0, 0, -1], 
        vertices: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]
    },
    // Right face
    { 
        dir: [1, 0, 0], 
        vertices: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]
    },
    // Left face
    { 
        dir: [-1, 0, 0], 
        vertices: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]
    },
    // Top face
    { 
        dir: [0, 1, 0], 
        vertices: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]
    },
    // Bottom face
    { 
        dir: [0, -1, 0], 
        vertices: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]
    }
];

// Names of the faces for texture mapping
const faceNames = ["front", "back", "right", "left", "top", "bottom"];

// Helper function to get block properties
function getBlockProperties(blockType) {
    if (!blockType) return null;
    // Convert block type number to name
    const blockName = Object.keys(BLOCK_TYPES).find(key => BLOCK_TYPES[key] === blockType);
    
    if (!blockColors) {
        return { transparency: 1, color: { r: 1, g: 1, b: 1 } }; // Default if blockColors not available
    }
    
    return blockColors[blockName] || { 
        transparency: 1,
        color: { r: 1, g: 1, b: 1 }
    };
}

// Helper function to get block name from type
function getBlockName(blockType) {
    return Object.keys(BLOCK_TYPES).find(key => BLOCK_TYPES[key] === blockType) || "unknown";
}

// ===== FACE CULLING SYSTEM =====
// Optimizes rendering by hiding faces between blocks that aren't visible

// Helper function to check if a block is transparent
// Transparent blocks: transparency < 1 OR seeThrough === true
function isTransparentBlock(blockProps) {
    if (!blockProps) return false;
    return blockProps.transparency < 1 || blockProps.seeThrough === true;
}

// Helper function to check if a face should be culled
// Returns: true = cull (hide face), false = don't cull (show face)
//
// CULLING RULES:
// 1. UNLOADED CHUNKS: Hide faces at chunk boundaries until neighbor loads
// 2. SOLID BLOCKS:
//    - Solid-to-Solid: Hide face (both sides invisible)
//    - Solid-to-Transparent: Show face (solid visible through transparent)
//    - Solid-to-Air: Show face
// 3. TRANSPARENT BLOCKS:
//    - Transparent-to-Solid: Show face (transparent texture visible)
//    - Transparent-to-Same: Hide face (e.g., water-to-water)
//    - Transparent-to-Different: Show face (e.g., water-to-glass)
//    - Transparent-to-Air: Show face
function shouldCullFace(blockType, neighborType, neighborChunkLoaded, blockProps, neighborProps) {
    // RULE: If neighbor chunk isn't loaded, ALWAYS cull the face
    // Face will be shown once the chunk loads and updates neighbors
    if (!neighborChunkLoaded) {
        return true; // Hide face until neighbor chunk loads
    }
    
    // RULE: If there's no neighbor block (air), don't cull - show the face
    if (!neighborType || neighborType === 0) {
        return false; // Show face against air
    }
    
    // Get block properties if not provided
    if (!blockProps) blockProps = getBlockProperties(blockType);
    if (!neighborProps) neighborProps = getBlockProperties(neighborType);
    
    // If either block doesn't have properties, treat as opaque solid blocks
    if (!blockProps) return true; // No props for current block - hide face
    if (!neighborProps) return true; // No props for neighbor - assume solid, hide face
    
    // Check if blocks are transparent
    const isCurrentTransparent = isTransparentBlock(blockProps);
    const isNeighborTransparent = isTransparentBlock(neighborProps);
    
    // === SOLID BLOCK CULLING RULES ===
    if (!isCurrentTransparent) {
        // RULE: Solid block against solid block - cull the face
        if (!isNeighborTransparent) {
            return true; // Hide face between two solid blocks
        }
        
        // RULE: Solid block against transparent block - don't cull
        return false; // Show solid face behind transparent block
    }
    
    // === TRANSPARENT BLOCK CULLING RULES ===
    if (isCurrentTransparent) {
        // RULE: Transparent against solid - don't cull (show transparent texture)
        if (!isNeighborTransparent) {
            return false; // Show transparent block against solid
        }
        
        // RULE: Transparent against transparent
        // Only cull if it's the SAME block type (e.g., water-to-water)
        if (blockType === neighborType) {
            return true; // Hide face between same transparent blocks
        }
        
        // RULE: Different transparent blocks (e.g., water-to-glass) - don't cull
        return false; // Show face between different transparent blocks
    }
    
    // Default: don't cull
    return false;
}


// Build Chunk Geometry function - moved from index.html to worker
function buildChunkGeometry(chunkData, cx, cz) {
    // Create separate arrays for each textured block type
    const texturedGeometries = {};
    const oVertices = [], oIndices = [], oUVs = [], oColors = [];
    let oVertexCount = 0;
    const tVertices = [], tIndices = [], tUVs = [], tColors = [];
    let tVertexCount = 0;

    // Pre-cache neighboring chunk data for performance
    const neighborChunkCache = {
        left: chunkStorage.get(`${cx - 1},${cz}`),
        right: chunkStorage.get(`${cx + 1},${cz}`),
        front: chunkStorage.get(`${cx},${cz + 1}`),
        back: chunkStorage.get(`${cx},${cz - 1}`)
    };

    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let y = 0; y < WORLD_HEIGHT; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const col = chunkData[x];
                if (!col) continue;
                const row = col[y];
                if (!row) continue;
                let blockType = row[z] || 0;
                if (blockType === 0) continue;
                
                const blockName = getBlockName(blockType);
                const colObj = blockColors[blockName] || { color: { r: 1, g: 1, b: 1 }, transparency: 1 };

                for (let f = 0; f < faces.length; f++) {
                    const face = faces[f];
                    const faceName = faceNames[f];
                    const nx = x + face.dir[0];
                    const ny = y + face.dir[1];
                    const nz = z + face.dir[2];
                    
                    // Check neighbor block - optimized with cache
                    let neighbor = 0; // Default to air
                    let isNeighborChunkLoaded = true;
                    
                    if (ny < 0 || ny >= WORLD_HEIGHT) {
                        // Y out of bounds - treat as air
                        neighbor = 0;
                    } else if (nx < 0) {
                        // Left neighbor chunk
                        if (neighborChunkCache.left) {
                            const ncol = neighborChunkCache.left[CHUNK_SIZE - 1];
                            neighbor = (ncol && ncol[ny] && ncol[ny][nz]) || 0;
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else if (nx >= CHUNK_SIZE) {
                        // Right neighbor chunk
                        if (neighborChunkCache.right) {
                            const ncol = neighborChunkCache.right[0];
                            neighbor = (ncol && ncol[ny] && ncol[ny][nz]) || 0;
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else if (nz < 0) {
                        // Back neighbor chunk
                        if (neighborChunkCache.back) {
                            const ncol = neighborChunkCache.back[nx];
                            neighbor = (ncol && ncol[ny] && ncol[ny][CHUNK_SIZE - 1]) || 0;
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else if (nz >= CHUNK_SIZE) {
                        // Front neighbor chunk
                        if (neighborChunkCache.front) {
                            const ncol = neighborChunkCache.front[nx];
                            neighbor = (ncol && ncol[ny] && ncol[ny][0]) || 0;
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else {
                        // Within same chunk
                        const ncol = chunkData[nx];
                        neighbor = (ncol && ncol[ny] && ncol[ny][nz]) || 0;
                    }

                    // Get neighbor properties once for efficiency
                    const neighborProps = neighbor ? getBlockProperties(neighbor) : null;

                    // Check if this face should be culled
                    // Pass colObj as blockProps to avoid redundant lookup
                    if (shouldCullFace(blockType, neighbor, isNeighborChunkLoaded, colObj, neighborProps)) {
                        continue;
                    }

                    // Check if this block has any textures at all
                    let hasFaceSpecificTexture = colObj.faces && colObj.faces[faceName] && colObj.faces[faceName].hasTexture;
                    let hasDefaultTexture = colObj.hasDefaultTexture;
                    
                    // For textured blocks, we'll add them based on block name and face
                    // Create separate geometry groups for face-specific textures vs default texture
                    if (hasFaceSpecificTexture || hasDefaultTexture) {
                        // Create geometry arrays for this block+face if they don't exist
                        const textureKey = blockName + (hasFaceSpecificTexture ? '_' + faceName : '');
                        if (!texturedGeometries[textureKey]) {
                            texturedGeometries[textureKey] = {
                                vertices: [],
                                indices: [],
                                uvs: [],
                                vertexCount: 0,
                                blockName: blockName,
                                faceName: hasFaceSpecificTexture ? faceName : null,
                                color: colObj.color || { r: 1, g: 1, b: 1 }
                            };
                        }

                        const geo = texturedGeometries[textureKey];
                        for (let i = 0; i < 4; i++) {
                            const v = face.vertices[i];
                            geo.vertices.push(
                                cx * CHUNK_SIZE + x + v[0],
                                y + v[1],
                                cz * CHUNK_SIZE + z + v[2]
                            );
                        }
                        
                        // Push UVs based on face
                        geo.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
                        
                        geo.indices.push(
                            geo.vertexCount, geo.vertexCount + 1, geo.vertexCount + 2,
                            geo.vertexCount, geo.vertexCount + 2, geo.vertexCount + 3
                        );
                        geo.vertexCount += 4;
                        continue;
                    }

                    // Handle non-textured faces
                    const baseColor = colObj.color || { r: 1, g: 1, b: 1 };
                    if (colObj.transparency === 1) {
                        for (let i = 0; i < 4; i++) {
                            const vertex = face.vertices[i];
                            oVertices.push(
                                cx * CHUNK_SIZE + x + vertex[0],
                                y + vertex[1],
                                cz * CHUNK_SIZE + z + vertex[2]
                            );
                            oColors.push(baseColor.r, baseColor.g, baseColor.b);
                        }
                        oUVs.push(0, 0, 1, 0, 1, 1, 0, 1);
                        oIndices.push(
                            oVertexCount, oVertexCount + 1, oVertexCount + 2,
                            oVertexCount, oVertexCount + 2, oVertexCount + 3
                        );
                        oVertexCount += 4;
                    } else {
                        for (let i = 0; i < 4; i++) {
                            const vertex = face.vertices[i];
                            tVertices.push(
                                cx * CHUNK_SIZE + x + vertex[0],
                                y + vertex[1],
                                cz * CHUNK_SIZE + z + vertex[2]
                            );
                            tColors.push(baseColor.r, baseColor.g, baseColor.b);
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

    // Create array typed buffers for efficient transfer
    const geometryData = {
        opaque: {
            vertices: new Float32Array(oVertices),
            indices: new Uint32Array(oIndices),
            uvs: new Float32Array(oUVs),
            colors: new Float32Array(oColors)
        },
        transparent: {
            vertices: new Float32Array(tVertices),
            indices: new Uint32Array(tIndices),
            uvs: new Float32Array(tUVs),
            colors: new Float32Array(tColors)
        },
        textured: []
    };

    // Convert textured geometries to typed arrays
    for (const [key, geo] of Object.entries(texturedGeometries)) {
        geometryData.textured.push({
            key: key,
            vertices: new Float32Array(geo.vertices),
            indices: new Uint32Array(geo.indices),
            uvs: new Float32Array(geo.uvs),
            blockName: geo.blockName,
            faceName: geo.faceName,
            color: geo.color || { r: 1, g: 1, b: 1 } // Include color for fallback rendering
        });
    }

    return geometryData;
}

// Helper function to get all transferable buffers from geometry data
function getTransferableBuffers(geometryData) {
    const buffers = [
        geometryData.opaque.vertices.buffer,
        geometryData.opaque.indices.buffer,
        geometryData.opaque.uvs.buffer,
        geometryData.opaque.colors.buffer,
        geometryData.transparent.vertices.buffer,
        geometryData.transparent.indices.buffer,
        geometryData.transparent.uvs.buffer,
        geometryData.transparent.colors.buffer
    ];
    
    // Add textured geometry buffers
    if (geometryData.textured) {
        for (const tex of geometryData.textured) {
            buffers.push(tex.vertices.buffer);
            buffers.push(tex.indices.buffer);
            buffers.push(tex.uvs.buffer);
        }
    }
    
    return buffers;
}

// Fast-path geometry builder for flat worlds using heightMap (top faces only)
function buildChunkGeometryFast(chunkData, cx, cz) {
        const texturedGeometries = {};
        const oVertices = [], oIndices = [], oUVs = [], oColors = [];
        let oVertexCount = 0;
        const tVertices = [], tIndices = [], tUVs = [], tColors = [];
        let tVertexCount = 0;

        const heightMap = chunkData.heightMap;
        if (!heightMap) {
            // Fallback to full builder if heightMap not present
            return buildChunkGeometry(chunkData, cx, cz);
        }

        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const idx = z * CHUNK_SIZE + x;
                let topY = heightMap[idx];
                if (topY === undefined || topY === null || topY < 0) continue;

                // Get top block type from data if available
                const col = chunkData[x];
                if (!col) continue;
                const row = col[topY];
                if (!row) continue;
                const blockType = row[z] || 0;
                if (blockType === 0) continue;

                const blockName = getBlockName(blockType);
                const colObj = blockColors[blockName] || { color: { r: 1, g: 1, b: 1 }, transparency: 1 };

                // Only add top face at (x, topY, z)
                const face = faces[4]; // top
                const faceName = faceNames[4];

                // Check textures
                let hasFaceSpecificTexture = colObj.faces && colObj.faces[faceName] && colObj.faces[faceName].hasTexture;
                let hasDefaultTexture = colObj.hasDefaultTexture;

                if (hasFaceSpecificTexture || hasDefaultTexture) {
                    const textureKey = blockName + (hasFaceSpecificTexture ? '_' + faceName : '');
                    if (!texturedGeometries[textureKey]) {
                        texturedGeometries[textureKey] = {
                            vertices: [],
                            indices: [],
                            uvs: [],
                            vertexCount: 0,
                            blockName: blockName,
                            faceName: hasFaceSpecificTexture ? faceName : null,
                            color: colObj.color || { r: 1, g: 1, b: 1 }
                        };
                    }
                    const geo = texturedGeometries[textureKey];
                    for (let i = 0; i < 4; i++) {
                        const v = face.vertices[i];
                        geo.vertices.push(
                            cx * CHUNK_SIZE + x + v[0],
                            topY + v[1],
                            cz * CHUNK_SIZE + z + v[2]
                        );
                    }
                    geo.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
                    geo.indices.push(
                        geo.vertexCount, geo.vertexCount + 1, geo.vertexCount + 2,
                        geo.vertexCount, geo.vertexCount + 2, geo.vertexCount + 3
                    );
                    geo.vertexCount += 4;
                } else {
                    const baseColor = colObj.color || { r: 1, g: 1, b: 1 };
                    for (let i = 0; i < 4; i++) {
                        const v = face.vertices[i];
                        oVertices.push(
                            cx * CHUNK_SIZE + x + v[0],
                            topY + v[1],
                            cz * CHUNK_SIZE + z + v[2]
                        );
                        oColors.push(baseColor.r, baseColor.g, baseColor.b);
                    }
                    oUVs.push(0, 0, 1, 0, 1, 1, 0, 1);
                    oIndices.push(
                        oVertexCount, oVertexCount + 1, oVertexCount + 2,
                        oVertexCount, oVertexCount + 2, oVertexCount + 3
                    );
                    oVertexCount += 4;
                }
            }
        }

        const geometryData = {
            opaque: {
                vertices: new Float32Array(oVertices),
                indices: new Uint32Array(oIndices),
                uvs: new Float32Array(oUVs),
                colors: new Float32Array(oColors)
            },
            transparent: {
                vertices: new Float32Array(tVertices),
                indices: new Uint32Array(tIndices),
                uvs: new Float32Array(tUVs),
                colors: new Float32Array(tColors)
            },
            textured: []
        };

        for (const [key, geo] of Object.entries(texturedGeometries)) {
            geometryData.textured.push({
                key,
                vertices: new Float32Array(geo.vertices),
                indices: new Uint32Array(geo.indices),
                uvs: new Float32Array(geo.uvs),
                blockName: geo.blockName,
                faceName: geo.faceName,
                color: geo.color || { r: 1, g: 1, b: 1 }
            });
        }

        return geometryData;
    }

// Helper function to get block from chunk data, handling chunk boundaries (sparse-aware)
function getBlockFromChunks(globalX, y, globalZ) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    
    const cx = Math.floor(globalX / CHUNK_SIZE);
    const cz = Math.floor(globalZ / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    
    // Check if we have this chunk
    const chunk = chunkStorage.get(key);
    if (!chunk) return 0;
    
    const localX = ((globalX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localZ = ((globalZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    
    const col = chunk[localX];
    if (!col) return 0;
    const row = col[y];
    if (!row) return 0;
    return row[localZ] || 0;
}

// Helper function to check if a chunk is loaded
function isChunkLoaded(cx, cz) {
    return chunkStorage.has(`${cx},${cz}`);
}

// Noise generator (copied from main thread since we can't share functions)
var ImprovedNoise = function () {
    var seededRandom = seededRandomGenerator(worldSeed);
    var p = [];
    for (var i = 0; i < 256; i++) {
        p[i] = Math.floor(seededRandom() * 256);
    }
    var permutation = new Array(512);
    for (var i = 0; i < 256; i++) {
        permutation[i] = p[i];
        permutation[i + 256] = p[i];
    }
    function fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }
    function lerp(t, a, b) {
        return a + t * (b - a);
    }
    function grad(hash, x, y, z) {
        var h = hash & 15;
        var u = h < 8 ? x : y;
        var v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }
    return {
        noise: function (x, y, z) {
            var floorX = Math.floor(x), floorY = Math.floor(y), floorZ = Math.floor(z);
            var X = floorX & 255, Y = floorY & 255, Z = floorZ & 255;
            x -= floorX;
            y -= floorY;
            z -= floorZ;
            var u = fade(x), v = fade(y), w = fade(z);
            var A = permutation[X] + Y, AA = permutation[A] + Z, AB = permutation[A + 1] + Z;
            var B = permutation[X + 1] + Y, BA = permutation[B] + Z, BB = permutation[B + 1] + Z;
            return lerp(w,
                lerp(v,
                    lerp(u, grad(permutation[AA], x, y, z), grad(permutation[BA], x - 1, y, z)),
                    lerp(u, grad(permutation[AB], x, y - 1, z), grad(permutation[BB], x - 1, y - 1, z))
                ),
                lerp(v,
                    lerp(u, grad(permutation[AA + 1], x, y, z - 1), grad(permutation[BA + 1], x - 1, y, z - 1)),
                    lerp(u, grad(permutation[AB + 1], x, y - 1, z - 1), grad(permutation[BB + 1], x - 1, y - 1, z - 1))
                )
            );
        }
    };
};

// Copy of seededRandomGenerator since we need it for ImprovedNoise
function seededRandomGenerator(seed) {
    var m = 0x80000000;
    var a = 1103515245;
    var c = 12345;
    var g = 7499755 * seed / c;
    var u = c - seed * g;
    var state = seed ? seed : Math.floor(g * m % seed);
    return function() {
        state = (a * (state) + c) % m;
        return state / (m - 1);
    };
}

// New: Build raw geometry data for a chunk
function buildGeometryData(chunkData, cx, cz) {
    // Copy buildChunkGeometry logic but collect raw arrays
    const oVertices = [], oUVs = [], oColors = [], oIndices = [];
    const tVertices = [], tUVs = [], tColors = [], tIndices = [];
    const textured = [];

    // Loop over chunkData to build geometry
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let y = 0; y < WORLD_HEIGHT; y++) {
                const blockType = chunkData[x][y][z];
                if (blockType === 0) continue; // Skip empty blocks

                const properties = getBlockProperties(blockType);
                const isTransparent = properties && properties.transparency < 1;

                // Determine if we should cull faces based on neighbors
                const neighbors = [
                    { dx: 0, dy: 0, dz: 1 },   // Front
                    { dx: 0, dy: 0, dz: -1 },  // Back
                    { dx: 1, dy: 0, dz: 0 },   // Right
                    { dx: -1, dy: 0, dz: 0 },  // Left
                    { dx: 0, dy: 1, dz: 0 },   // Top
                    { dx: 0, dy: -1, dz: 0 }   // Bottom
                ];

                const faceCull = neighbors.map(dir => {
                    const nx = x + dir.dx, ny = y + dir.dy, nz = z + dir.dz;
                    const neighborType = (nx >= 0 && nz >= 0 && nx < CHUNK_SIZE && nz < CHUNK_SIZE) ? chunkData[nx][ny] && chunkData[nx][ny][nz] : 0;
                    return shouldCullFace(blockType, neighborType, isChunkLoaded(cx + dir.dx, cz + dir.dz));
                });

                // Push vertices, uvs, colors, indices for each face not culled
                const addFace = (verts, uvs, cols, inds, baseIndex) => {
                    const startIndex = verts.length / 3;
                    verts.push(...verts.slice(baseIndex * 3, baseIndex * 3 + 3));
                    uvs.push(...uvs.slice(baseIndex * 2, baseIndex * 2 + 2));
                    cols.push(...cols.slice(baseIndex * 4, baseIndex * 4 + 4));
                    inds.push(startIndex);
                };

                // Opaque and transparent face handling
                if (!isTransparent) {
                    // Handle opaque block faces
                    if (!faceCull[0]) addFace(oVertices, oUVs, oColors, oIndices, 0); // Front
                    if (!faceCull[1]) addFace(oVertices, oUVs, oColors, oIndices, 1); // Back
                    if (!faceCull[2]) addFace(oVertices, oUVs, oColors, oIndices, 2); // Right
                    if (!faceCull[3]) addFace(oVertices, oUVs, oColors, oIndices, 3); // Left
                    if (!faceCull[4]) addFace(oVertices, oUVs, oColors, oIndices, 4); // Top
                    if (!faceCull[5]) addFace(oVertices, oUVs, oColors, oIndices, 5); // Bottom
                } else {
                    // Handle transparent block faces
                    if (!faceCull[0]) addFace(tVertices, tUVs, tColors, tIndices, 0); // Front
                    if (!faceCull[1]) addFace(tVertices, tUVs, tColors, tIndices, 1); // Back
                    if (!faceCull[2]) addFace(tVertices, tUVs, tColors, tIndices, 2); // Right
                    if (!faceCull[3]) addFace(tVertices, tUVs, tColors, tIndices, 3); // Left
                    if (!faceCull[4]) addFace(tVertices, tUVs, tColors, tIndices, 4); // Top
                    if (!faceCull[5]) addFace(tVertices, tUVs, tColors, tIndices, 5); // Bottom
                }
            }
        }
    }

    // At end, return raw arrays
    return {
        opaque: { vertices: new Float32Array(oVertices), uvs: new Float32Array(oUVs), colors: new Float32Array(oColors), indices: new Uint32Array(oIndices) },
        transparent: { vertices: new Float32Array(tVertices), uvs: new Float32Array(tUVs), colors: new Float32Array(tColors), indices: new Uint32Array(tIndices) },
        textured // keep textureKey and raw arrays per entry
    };
}

// Main chunk generation function (multinoise pipeline)
function generateChunkData(cx, cz) {
    const startTime = performance.now();
    
    // Create the data array with chunk coordinates
    const data = new Array(CHUNK_SIZE);
    data.chunkX = cx;
    data.chunkZ = cz;
    // Per-chunk height map (stores top filled Y for each column)
    const heightMap = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE);
    
    // Create multinoise sampler and helpers
    const sampler = new MultiNoiseSampler(worldSeed, true);
    const fields = sampler.precomputeChunk(cx, cz, CHUNK_SIZE);
    const seaLevel = (TERRAIN_BOUNDS && (TERRAIN_BOUNDS.sea_level != null)) ? TERRAIN_BOUNDS.sea_level : 50;
    const shaper = new TerrainShaper(TERRAIN_BOUNDS, seaLevel);
    const biomeAssigner = new BiomeAssigner(BIOMES);

    // Generate terrain based on multinoise + biome blending
    for (let x = 0; x < CHUNK_SIZE; x++) {
        data[x] = [];
        for (let z = 0; z < CHUNK_SIZE; z++) {
            // Calculate world coordinates
            const worldX = cx * CHUNK_SIZE + x;
            const worldZ = cz * CHUNK_SIZE + z;
            const idx = z * CHUNK_SIZE + x;

            // Climate fields
            const temp01 = fields.t[idx];
            const humid01 = fields.h[idx];
            const biomePick = biomeAssigner.pick(temp01, humid01);
            const biome = (biomePick.primary && ((BIOMES && BIOMES.biomes && BIOMES.biomes[biomePick.primary]) || (BIOMES && BIOMES[biomePick.primary]))) || {};

            // Elevation fields for this column
            const elev = shaper.elevation({ c: fields.c[idx], e: fields.e[idx], pv: fields.pv[idx] }, biomePick.params);
            const h = Math.floor(elev);
            const topY = h - 1; // top block index
            heightMap[z * CHUNK_SIZE + x] = topY;
            
            // Get biome layers
            const layersToUse = biome.layers;
            const defaultLayerToUse = biome.defaultLayer;

            // Fill terrain layers from top down
            let remaining = h;
            if (layersToUse && Array.isArray(layersToUse) && layersToUse.length > 0) {
                for (let i = 0; i < layersToUse.length && remaining > 0; i++) {
                    const layer = layersToUse[i];
                    let thickness = 0;
                    const thicknessDef = layer.number;
                    
                    if (typeof thicknessDef === "string") {
                        if (thicknessDef.includes("-")) {
                            const [min, max] = thicknessDef.split("-").map(Number);
                            thickness = Math.floor(Math.random() * (max - min + 1)) + min;
                        } else {
                            thickness = parseInt(thicknessDef);
                        }
                    } else {
                        thickness = thicknessDef;
                    }
                    
                    thickness = Math.min(thickness, remaining);
                    const blockType = BLOCK_TYPES[layer.type];
                    
                    const startY = remaining - thickness;
                    const endY = remaining;
                    for (let y = startY; y < endY; y++) {
                        if (y >= 0 && y < WORLD_HEIGHT) {
                            if (!data[x][y]) data[x][y] = [];
                            data[x][y][z] = blockType;
                        }
                    }
                    remaining -= thickness;
                }
            }
            
            // Fill remaining with default layer
            const defaultBlockType = BLOCK_TYPES[defaultLayerToUse];
            if (remaining > 0 && defaultBlockType !== undefined) {
                const endY = Math.min(remaining, WORLD_HEIGHT);
                for (let y = 0; y < endY; y++) {
                    if (!data[x][y]) data[x][y] = [];
                    data[x][y][z] = defaultBlockType;
                }
            }

            // Optional: water fill below sea level if water block exists and column is below
            const waterId = BLOCK_TYPES && (BLOCK_TYPES.water || BLOCK_TYPES.WATER);
            if (waterId !== undefined) {
                const maxWaterY = Math.min(seaLevel, WORLD_HEIGHT - 1);
                for (let y = 0; y <= maxWaterY; y++) {
                    if (!data[x][y]) data[x][y] = [];
                    if (!data[x][y][z] || data[x][y][z] === 0) {
                        data[x][y][z] = waterId;
                    }
                }
            }
        }
    }

    // attach height map
    data.heightMap = heightMap;

    // Store chunk in global storage
    const key = `${cx},${cz}`;
    chunkStorage.set(key, data);

    const totalTime = performance.now() - startTime;
    
    if (totalTime > 100) {
        console.log(`⚡ Chunk (${cx},${cz}) generated in ${totalTime.toFixed(1)}ms`);
    }

    return data;
}

// Message handler
self.onmessage = function(e) {
    const { cx, cz, constants, type, modifiedChunk, requestGeometry, isPriority } = e.data;
    
    // Priority chunks bypass normal queue processing (handled immediately)
    // This ensures modified chunks update instantly for better user experience
    
    if (type === "updateChunk") {
        // Store modified chunk data
        const key = `${cx},${cz}`;
        chunkStorage.set(key, modifiedChunk);
        
        // Update neighboring chunks in storage
        const neighbors = [
            [cx - 1, cz], [cx + 1, cz],
            [cx, cz - 1], [cx, cz + 1]
        ];
        
        // Queue updates for all affected chunks
        const chunksToUpdate = new Set([key]);
        for (const [ncx, ncz] of neighbors) {
            const nKey = `${ncx},${ncz}`;
            if (chunkStorage.has(nKey)) {
                chunksToUpdate.add(nKey);
            }
        }
        
        // Send updates for all affected chunks
        for (const chunkKey of chunksToUpdate) {
            const [updateCx, updateCz] = chunkKey.split(',').map(Number);
            const chunkToUpdate = chunkStorage.get(chunkKey);
            if (chunkToUpdate) {
                // Build geometry data and send it back
                const geometryData = buildChunkGeometry(chunkToUpdate, updateCx, updateCz);
                self.postMessage({
                    type: "chunkUpdated",
                    cx: updateCx,
                    cz: updateCz,
                    geometryData: geometryData
                }, getTransferableBuffers(geometryData));
            }
        }
        return;
    }
    
    // Set up constants received from main thread
    if (constants) {
        CHUNK_SIZE = constants.CHUNK_SIZE;
        WORLD_HEIGHT = constants.WORLD_HEIGHT;
        BLOCK_TYPES = constants.BLOCK_TYPES;
        BIOMES = constants.BIOMES;
        worldSeed = constants.worldSeed;
        blockColors = constants.blockColors;
        
        // Advanced terrain system constants
        BIOME_ADJACENCY = constants.BIOME_ADJACENCY;
        GEOLOGICAL_FORMATIONS = constants.GEOLOGICAL_FORMATIONS;
        TERRAIN_BOUNDS = constants.TERRAIN_BOUNDS;
        NOISE_CONFIG = constants.NOISE_CONFIG;
        
        // Initialize advanced noise generator
        if (constants.AdvancedNoiseGenerator) {
            // Reconstruct the AdvancedNoiseGenerator class from string
            AdvancedNoiseGenerator = new Function('ImprovedNoise', 'return ' + constants.AdvancedNoiseGenerator)(ImprovedNoise);
        }
        
        // Convert string functions back to actual functions
        StructureGenerators = {};
        if (constants.StructureGenerators) {
            for (const [key, fnString] of Object.entries(constants.StructureGenerators)) {
                StructureGenerators[key] = new Function('return ' + fnString)();
            }
        }
    }

    // Check if we have this chunk stored
    const key = `${cx},${cz}`;
    let chunkData = chunkStorage.get(key);
    
    // If not in storage, generate new chunk
    if (!chunkData) {
        chunkData = generateChunkData(cx, cz);
        chunkStorage.set(key, chunkData);
        
    // Build geometry data in the worker - use FULL builder to include all faces
        const geometryData = buildChunkGeometry(chunkData, cx, cz);
        
        // Get all neighboring chunks that need updating - only send if needed
        const neighbors = [
            [cx - 1, cz], [cx + 1, cz],
            [cx, cz - 1], [cx, cz + 1]
        ];
        
        // Transfer the typed arrays to avoid copying the data
        // Send both chunk data and geometry data for new chunks
        self.postMessage({ 
            cx, 
            cz, 
            chunkData,
            geometryData
        }, getTransferableBuffers(geometryData));
        
        // Then update all existing neighbors that might need re-rendering
        for (const [ncx, ncz] of neighbors) {
            const nKey = `${ncx},${ncz}`;
            if (chunkStorage.has(nKey)) {
                const neighborData = chunkStorage.get(nKey);
                // Use FULL geometry builder for neighbor updates to include all faces
                const neighborGeom = buildChunkGeometry(neighborData, ncx, ncz);
                
                self.postMessage({
                    type: "chunkUpdated",
                    cx: ncx,
                    cz: ncz,
                    geometryData: neighborGeom
                }, getTransferableBuffers(neighborGeom));
            }
        }
        return;
    }
    
    // If geometry was requested, build and return it
    if (requestGeometry) {
        // Use FULL builder to include all faces
        const geometryData = buildChunkGeometry(chunkData, cx, cz);
        
        self.postMessage({ 
            cx, 
            cz, 
            geometryData 
        }, getTransferableBuffers(geometryData));
    } else {
        // Just send the chunk data, legacy behavior
        self.postMessage({ cx, cz, chunkData });
    }
};

// Helper to enforce biome spacing rule (no same biome within MIN_DIST)
// Removed obsolete biome smoothing code