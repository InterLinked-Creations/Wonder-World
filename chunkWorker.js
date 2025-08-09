// Chunk Worker
// Note: We'll receive needed variables and constants from the main thread

let CHUNK_SIZE, WORLD_HEIGHT, BLOCK_TYPES, BIOMES, worldSeed, StructureGenerators;
let blockColors; // Will be populated from main thread

// Advanced terrain system constants (mirrored from main thread)
let BIOME_ADJACENCY, GEOLOGICAL_FORMATIONS, TERRAIN_BOUNDS, NOISE_CONFIG;
let AdvancedNoiseGenerator;

// Add chunk storage
const chunkStorage = new Map();
const neighborChunks = new Map(); // Store neighboring chunks for proper culling
const biomeStorage = new Map(); // Store computed biomes for adjacency checking

// Advanced terrain generation helper functions (worker versions)
function areBiomesCompatible(biome1, biome2) {
    if (!BIOME_ADJACENCY || !BIOME_ADJACENCY[biome1] || !BIOME_ADJACENCY[biome2]) return false;
    
    const biome1Compat = BIOME_ADJACENCY[biome1];
    return biome1Compat.compatible.includes(biome2) || 
           biome1Compat.transitional.includes(biome2);
}

function getBiomeTransitionType(biome1, biome2) {
    if (!BIOME_ADJACENCY || !BIOME_ADJACENCY[biome1]) return 'incompatible';
    
    const compat = BIOME_ADJACENCY[biome1];
    if (compat.compatible.includes(biome2)) return 'direct';
    if (compat.transitional.includes(biome2)) return 'buffered';
    return 'incompatible';
}

function calculateSophisticatedHeight(x, z, biomeName, noiseGen, neighborBiomes) {
    if (!BIOMES || !BIOMES[biomeName] || !NOISE_CONFIG || !TERRAIN_BOUNDS) {
        // Fallback to simple height calculation
        const n = noiseGen.noise(x * 0.01, 0, z * 0.01);
        return Math.floor(65 + n * 15);
    }
    
    const biome = BIOMES[biomeName];
    
    // Base continental elevation
    const continentalNoise = multiOctaveNoise(noiseGen, x, z, NOISE_CONFIG.continental);
    const regionalNoise = multiOctaveNoise(noiseGen, x, z, NOISE_CONFIG.regional);
    const continentalShape = continentalNoise * 0.7 + regionalNoise * 0.3;
    let elevation = TERRAIN_BOUNDS.sea_level + continentalShape;
    elevation = Math.max(TERRAIN_BOUNDS.min_elevation, elevation);
    
    // Apply geological formations if available
    if (GEOLOGICAL_FORMATIONS) {
        const formationNoise = multiOctaveNoise(noiseGen, x, z, NOISE_CONFIG.formation || { frequency: 0.005, amplitude: 20, octaves: 3 });
        const formationStrength = Math.abs(formationNoise);
        
        if (formationStrength > 0.7 && GEOLOGICAL_FORMATIONS.MESA) {
            const mesa = GEOLOGICAL_FORMATIONS.MESA;
            const plateauNoise = ridgedNoise(noiseGen, x, z, { frequency: 0.008, amplitude: 15, octaves: 2 });
            elevation += plateauNoise * mesa.elevation_modifier;
        } else if (formationStrength > 0.4 && GEOLOGICAL_FORMATIONS.RIDGE) {
            const ridge = GEOLOGICAL_FORMATIONS.RIDGE;
            const ridgeNoise = ridgedNoise(noiseGen, x, z, { frequency: 0.015, amplitude: 20, octaves: 3 });
            elevation += ridgeNoise * ridge.elevation_modifier;
        } else if (formationNoise < -0.4 && GEOLOGICAL_FORMATIONS.VALLEY) {
            const valley = GEOLOGICAL_FORMATIONS.VALLEY;
            const valleyDepth = Math.abs(formationNoise + 0.4) * 30;
            elevation -= valleyDepth * valley.elevation_modifier;
        }
    }
    
    // Local biome-specific terrain
    const localNoise = multiOctaveNoise(noiseGen, x, z, NOISE_CONFIG.local);
    const detailNoise = multiOctaveNoise(noiseGen, x, z, NOISE_CONFIG.detail);
    const microNoise = multiOctaveNoise(noiseGen, x, z, NOISE_CONFIG.micro);
    
    // Combine local terrain features
    let biomeModification = localNoise * biome.heightVariation * 0.6;
    biomeModification += detailNoise * biome.heightVariation * 0.3;
    biomeModification += microNoise * biome.heightVariation * 0.1;
    
    // Apply biome-specific terrain characteristics
    if (biomeName.includes('mountain') || biomeName.includes('peaks')) {
        const ridgedTerrain = ridgedNoise(noiseGen, x, z, { frequency: 0.02, amplitude: 30, octaves: 4 });
        biomeModification += ridgedTerrain;
    } else if (biomeName.includes('desert') || biomeName.includes('dunes')) {
        const duneNoise = domainWarpedNoise(noiseGen, x, z, { frequency: 0.03, amplitude: 15, octaves: 3 }, 30);
        biomeModification += duneNoise * 0.8;
    } else if (biomeName.includes('ocean') || biomeName.includes('lake')) {
        biomeModification *= 0.3;
    }
    
    // Apply final biome modification
    elevation += biomeModification;
    
    // Ensure within bounds
    elevation = Math.max(TERRAIN_BOUNDS.min_elevation, 
                       Math.min(TERRAIN_BOUNDS.max_elevation, elevation));
    
    return Math.floor(elevation);
}

// Helper noise functions for the worker
function multiOctaveNoise(noiseGen, x, z, config) {
    let value = 0;
    let amplitude = config.amplitude;
    let frequency = config.frequency;
    let maxValue = 0;

    for (let i = 0; i < config.octaves; i++) {
        value += noiseGen.noise(x * frequency, 0, z * frequency) * amplitude;
        maxValue += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    return value / maxValue;
}

function ridgedNoise(noiseGen, x, z, config) {
    let value = 0;
    let amplitude = config.amplitude;
    let frequency = config.frequency;

    for (let i = 0; i < config.octaves; i++) {
        let n = Math.abs(noiseGen.noise(x * frequency, 0, z * frequency));
        n = 1.0 - n;
        n = n * n;
        value += n * amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    return value;
}

function domainWarpedNoise(noiseGen, x, z, config, warpStrength = 50) {
    const warpX = noiseGen.noise(x * 0.01, 0, z * 0.01) * warpStrength;
    const warpZ = noiseGen.noise(x * 0.01, 100, z * 0.01) * warpStrength;
    
    return multiOctaveNoise(noiseGen, x + warpX, z + warpZ, config);
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

// Helper function to check if a face should be culled
function shouldCullFace(blockType, neighborType, neighborChunkLoaded) {
    // If the neighbor chunk isn't loaded, always cull that face
    if (!neighborChunkLoaded) return true;
    
    // If there's no neighbor block, don't cull
    if (!neighborType) return false;
    
    const blockProps = getBlockProperties(blockType);
    const neighborProps = getBlockProperties(neighborType);
    
    // If either block doesn't have properties, treat as opaque
    if (!blockProps || !neighborProps) return neighborType !== 0;
    
    // If the neighbor is the same block type, always cull
    if (blockType === neighborType) return true;
    
    // If the neighbor is transparent or see-through, don't cull unless it's the same block type
    if (neighborProps.transparency < 1 || neighborProps.seeThrough) return false;
    
    // Otherwise, cull if there's a neighbor block
    return true;
}

// Build Chunk Geometry function - moved from index.html to worker
function buildChunkGeometry(chunkData, cx, cz) {
    // Create separate arrays for each textured block type
    const texturedGeometries = {};
    const oVertices = [], oIndices = [], oUVs = [], oColors = [];
    let oVertexCount = 0;
    const tVertices = [], tIndices = [], tUVs = [], tColors = [];
    let tVertexCount = 0;

    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let y = 0; y < WORLD_HEIGHT; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                let blockType = chunkData[x][y][z];
                if (blockType === 0) continue;
                
                const blockName = getBlockName(blockType);
                const colObj = blockColors[blockName] || { color: { r: 1, g: 1, b: 1 }, transparency: 1 };

                for (let f = 0; f < faces.length; f++) {
                    const face = faces[f];
                    const faceName = faceNames[f];
                    const nx = x + face.dir[0];
                    const ny = y + face.dir[1];
                    const nz = z + face.dir[2];
                    
                    // Get the actual global coordinates for proper neighbor checking
                    const globalX = cx * CHUNK_SIZE + x;
                    const globalZ = cz * CHUNK_SIZE + z;
                    
                    // Check neighbor block using global coordinates
                    let neighbor = 0; // Default to air if out of bounds
                    let isNeighborChunkLoaded = true;
                    
                    if (ny < 0 || ny >= WORLD_HEIGHT) {
                        // Y out of bounds - treat as air
                        neighbor = 0;
                    } else if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) {
                        // At chunk boundary - use global coordinates
                        const neighborGlobalX = globalX + face.dir[0];
                        const neighborGlobalZ = globalZ + face.dir[2];
                        const neighborCx = Math.floor(neighborGlobalX / CHUNK_SIZE);
                        const neighborCz = Math.floor(neighborGlobalZ / CHUNK_SIZE);
                        
                        // Check if neighbor chunk exists
                        const neighborKey = `${neighborCx},${neighborCz}`;
                        if (chunkStorage.has(neighborKey)) {
                            const neighborChunk = chunkStorage.get(neighborKey);
                            const neighborLocalX = ((neighborGlobalX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                            const neighborLocalZ = ((neighborGlobalZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                            neighbor = neighborChunk[neighborLocalX][ny][neighborLocalZ];
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else {
                        // Within same chunk and within bounds
                        neighbor = chunkData[nx][ny][nz];
                    }

                    // Check if this face should be culled
                    if (shouldCullFace(blockType, neighbor, isNeighborChunkLoaded)) {
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

// Helper function to get block from chunk data, handling chunk boundaries
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
    
    return chunk[localX][y][localZ];
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

// Main chunk generation function
function generateChunkData(cx, cz) {
    const startTime = performance.now();
    
    // Linear interpolation function
    function lerp(a, b, t) {
        return a * (1 - t) + b * t;
    }
    
    // Create a single noise generator instance for this chunk
    const noiseGenerator = new ImprovedNoise();
    
    // Seed-driven biome selection for consistent world generation
    function selectBiomeWithSeed(x, z, seed) {
        // Use multiple noise layers for natural biome distribution
        const biomeScale = 0.0008;
        const detailScale = 0.003;
        const warpScale = 0.0015;
        
        // Apply domain warping for organic biome shapes
        const warpX = noiseGenerator.noise((x + seed) * warpScale, seed * 0.001, z * warpScale) * 200;
        const warpZ = noiseGenerator.noise(x * warpScale, (seed + 1000) * 0.001, (z + seed) * warpScale) * 200;
        
        const warpedX = x + warpX;
        const warpedZ = z + warpZ;
        
        // Generate base biome noise
        const biomeNoise = noiseGenerator.noise(warpedX * biomeScale, seed * 0.01, warpedZ * biomeScale);
        const detailNoise = noiseGenerator.noise(warpedX * detailScale, (seed + 500) * 0.01, warpedZ * detailScale);
        const elevationNoise = noiseGenerator.noise(x * 0.001, (seed + 1500) * 0.01, z * 0.001);
        
        // Combine noises for biome selection
        const combinedNoise = (biomeNoise + detailNoise * 0.3 + elevationNoise * 0.2) / 1.5;
        const normalizedNoise = (combinedNoise + 1) / 2;
        
        // Create biome weight array based on rarity and size
        const biomeWeights = [];
        const biomeNames = Object.keys(BIOMES);
        
        for (const biomeName of biomeNames) {
            const biome = BIOMES[biomeName];
            const weight = (biome.rarity / 100) * biome.size * biome.size;
            biomeWeights.push({ name: biomeName, weight: weight, biome: biome });
        }
        
        biomeWeights.sort((a, b) => b.weight - a.weight);
        
        // Calculate elevation for biome filtering
        const elevation = 65 + elevationNoise * 80;
        
        // Filter biomes by elevation compatibility
        const suitableBiomes = biomeWeights.filter(item => {
            const heightDiff = Math.abs(elevation - item.biome.baseHeight);
            return heightDiff < item.biome.heightVariation * 1.5;
        });
        
        if (suitableBiomes.length === 0) {
            return "plains";
        }
        
        // Calculate cumulative weights
        let totalWeight = 0;
        for (const item of suitableBiomes) {
            totalWeight += item.weight;
        }
        
        // Select biome based on noise value
        let target = normalizedNoise * totalWeight;
        for (const item of suitableBiomes) {
            target -= item.weight;
            if (target <= 0) {
                return item.name;
            }
        }
        
        return suitableBiomes[0].name;
    }
    
    // Create biome and edge cache for this chunk
    const biomeCache = new Map();
    const edgeCache = new Map();
    
    // Pre-calculate biomes for the entire chunk area plus a buffer for edge detection
    const BUFFER_SIZE = 15; // Buffer around chunk for edge detection
    const chunkStartX = cx * CHUNK_SIZE;
    const chunkStartZ = cz * CHUNK_SIZE;
    
    const biomeCalcStart = performance.now();
    for (let x = -BUFFER_SIZE; x < CHUNK_SIZE + BUFFER_SIZE; x++) {
        for (let z = -BUFFER_SIZE; z < CHUNK_SIZE + BUFFER_SIZE; z++) {
            const globalX = chunkStartX + x;
            const globalZ = chunkStartZ + z;
            const key = `${globalX},${globalZ}`;
            
            // Use seed-driven biome selection for consistent world generation
            const biomeKey = selectBiomeWithSeed(globalX, globalZ, worldSeed);
            biomeCache.set(key, biomeKey);
            
            // Store in global biome storage for adjacency checking
            if (biomeStorage) {
                biomeStorage.set(key, biomeKey);
            }
        }
    }
    const biomeCalcTime = performance.now() - biomeCalcStart;
    
    // Enhanced biome transition and blending system
    function getBiomeWithTransitions(globalX, globalZ) {
        const baseBiome = getBiomeForChunk(globalX, globalZ);
        
        // Check if advanced terrain system is available for transitions
        if (!BIOME_ADJACENCY) {
            return baseBiome; // Fallback to simple biome
        }
        
        // Use a smaller, more efficient sampling pattern for performance
        const sampleOffsets = [
            [-20, 0], [20, 0], [0, -20], [0, 20],  // Cardinal directions
            [-15, -15], [15, -15], [-15, 15], [15, 15]  // Diagonals
        ];
        
        const nearbyBiomes = [];
        
        for (const [dx, dz] of sampleOffsets) {
            const nearbyBiome = getBiomeForChunk(globalX + dx, globalZ + dz);
            if (nearbyBiome !== baseBiome) {
                const distance = Math.sqrt(dx * dx + dz * dz);
                nearbyBiomes.push({ biome: nearbyBiome, distance: distance });
            }
        }
        
        if (nearbyBiomes.length === 0) {
            return baseBiome; // No transitions needed
        }
        
        // Find the closest incompatible biome (performance optimized)
        let closestIncompatible = null;
        let minDistance = Infinity;
        
        for (const nearby of nearbyBiomes) {
            if (getBiomeTransitionType(baseBiome, nearby.biome) === 'incompatible') {
                if (nearby.distance < minDistance) {
                    minDistance = nearby.distance;
                    closestIncompatible = nearby;
                }
            }
        }
        
        if (closestIncompatible && minDistance < 30) {
            // Create a transition zone using efficient noise sampling
            const transitionNoise = noiseGenerator.noise(globalX * 0.008, worldSeed * 0.001, globalZ * 0.008);
            const transitionStrength = (transitionNoise + 1) * 0.5; // 0 to 1
            
            // Insert transitional biome based on distance and noise
            const distanceFactor = 1 - (minDistance / 30);
            if (transitionStrength > (0.4 - distanceFactor * 0.2)) {
                // Select appropriate transition biome based on the incompatible biomes
                let transitionBiome = 'plains'; // Default
                
                if (baseBiome.includes('mountain') || closestIncompatible.biome.includes('mountain')) {
                    transitionBiome = 'hills';
                } else if (baseBiome.includes('desert') || closestIncompatible.biome.includes('desert')) {
                    transitionBiome = 'savanna';
                } else if (baseBiome.includes('ocean') || closestIncompatible.biome.includes('ocean')) {
                    transitionBiome = 'swamp';
                } else if (baseBiome.includes('snow') || closestIncompatible.biome.includes('snow')) {
                    transitionBiome = 'tundra';
                } else {
                    const options = ['plains', 'meadow', 'savanna'];
                    const index = Math.floor(transitionStrength * options.length);
                    transitionBiome = options[Math.min(index, options.length - 1)];
                }
                
                // Verify the transition biome exists and is compatible
                if (BIOMES[transitionBiome] && 
                    getBiomeTransitionType(baseBiome, transitionBiome) !== 'incompatible' &&
                    getBiomeTransitionType(transitionBiome, closestIncompatible.biome) !== 'incompatible') {
                    return transitionBiome;
                }
            }
        }
        
        return baseBiome;
    }
    
    // Create the data array with chunk coordinates
    const data = Array(CHUNK_SIZE).fill().map(() => 
        Array(WORLD_HEIGHT).fill().map(() => 
            Array(CHUNK_SIZE).fill(0)
        )
    );
    // Store chunk coordinates directly on the data object
    data.chunkX = cx;
    data.chunkZ = cz;

    // Optimized helper function to get biome with caching
    function getBiomeForChunk(globalX, globalZ) {
        const key = `${globalX},${globalZ}`;
        return biomeCache.get(key) || "ocean";
    }

    // Optimized helper function to check if a position is at the edge of its biome
    function isAtBiomeEdge(globalX, globalZ) {
        const currentBiomeKey = getBiomeForChunk(globalX, globalZ);
        const currentBiome = BIOMES[currentBiomeKey];
        
        // Use cache for edge detection
        const key = `${globalX},${globalZ}`;
        if (edgeCache.has(key)) {
            return edgeCache.get(key);
        }
        
        // Simplified edge detection - just check immediate neighbors
        const checkRadius = Math.min(5, currentBiome.edges ? Math.ceil(currentBiome.edges.size * 50) : 2);
        
        // Check only cardinal and diagonal directions for performance
        const checkPoints = [
            [-checkRadius, 0], [checkRadius, 0], [0, -checkRadius], [0, checkRadius],
            [-checkRadius, -checkRadius], [-checkRadius, checkRadius], 
            [checkRadius, -checkRadius], [checkRadius, checkRadius]
        ];
        
        for (const [dx, dz] of checkPoints) {
            const nearbyBiomeKey = getBiomeForChunk(globalX + dx, globalZ + dz);
            if (nearbyBiomeKey !== currentBiomeKey) {
                const result = {
                    isEdge: true,
                    nearbyBiomeKey: nearbyBiomeKey,
                    edgeDistance: Math.min(Math.abs(dx), Math.abs(dz)) / checkRadius
                };
                edgeCache.set(key, result);
                return result;
            }
        }
        
        const result = { isEdge: false };
        edgeCache.set(key, result);
        return result;
    }
    
    // Enhanced helper function to get height - uses sophisticated system when available
    function getHeightWithBiomeForChunk(globalX, globalZ) {
        const currentBiomeKey = getBiomeForChunk(globalX, globalZ);
        const currentBiome = BIOMES[currentBiomeKey];
        
        // If advanced terrain system is available, use it
        if (NOISE_CONFIG && TERRAIN_BOUNDS && GEOLOGICAL_FORMATIONS) {
            // Get nearby biomes for transition calculations
            const nearbyBiomes = [];
            for (let dx = -100; dx <= 100; dx += 50) {
                for (let dz = -100; dz <= 100; dz += 50) {
                    if (dx === 0 && dz === 0) continue;
                    const nearbyBiome = getBiomeForChunk(globalX + dx, globalZ + dz);
                    if (nearbyBiome !== currentBiomeKey) {
                        nearbyBiomes.push({
                            biome: nearbyBiome,
                            x: globalX + dx,
                            z: globalZ + dz
                        });
                    }
                }
            }
            
            return calculateSophisticatedHeight(globalX, globalZ, currentBiomeKey, noiseGenerator, nearbyBiomes);
        }
        
        // Fallback to existing height calculation system
        const edgeInfo = isAtBiomeEdge(globalX, globalZ);
        const hasEdgeProperties = currentBiome.edges !== undefined;
        
        // Decide whether to use edge properties and how much to blend
        let biomeToUse;
        
        if (edgeInfo.isEdge && hasEdgeProperties) {
            // Calculate blend factor (simplified)
            const blendFactor = currentBiome.edges.blend ? 
                Math.min(1, edgeInfo.edgeDistance * (currentBiome.edges.blend * 0.1)) : 
                edgeInfo.edgeDistance;
            
            // Pre-calculate blended values
            biomeToUse = {
                baseHeight: lerp(currentBiome.edges.baseHeight, currentBiome.baseHeight, blendFactor),
                heightVariation: lerp(currentBiome.edges.heightVariation, currentBiome.heightVariation, blendFactor),
                frequency: currentBiome.edges.frequency || currentBiome.frequency
            };
        } else {
            biomeToUse = currentBiome;
        }
        
        // Enhanced transition calculation with multi-octave noise
        if (currentBiome.transition === "None") {
            // Generate multiple octaves of noise for more natural terrain
            const scale1 = biomeToUse.frequency;
            const scale2 = biomeToUse.frequency * 2.5;
            const scale3 = biomeToUse.frequency * 6.0;
            const scale4 = biomeToUse.frequency * 15.0;
            
            // Primary terrain shape (large features)
            const noise1 = noiseGenerator.noise(globalX * scale1, 0, globalZ * scale1);
            // Secondary terrain variation (medium features)
            const noise2 = noiseGenerator.noise(globalX * scale2, 100, globalZ * scale2) * 0.5;
            // Tertiary detail (small features)
            const noise3 = noiseGenerator.noise(globalX * scale3, 200, globalZ * scale3) * 0.25;
            // Fine detail (micro features)
            const noise4 = noiseGenerator.noise(globalX * scale4, 300, globalZ * scale4) * 0.125;
            
            // Combine octaves with different weights based on biome type
            let combinedNoise;
            if (currentBiomeKey.includes('mountain') || currentBiomeKey.includes('peaks') || currentBiomeKey.includes('hills')) {
                // Mountains need more dramatic height variation
                combinedNoise = noise1 + noise2 * 0.8 + noise3 * 0.4 + noise4 * 0.2;
            } else if (currentBiomeKey.includes('plains') || currentBiomeKey.includes('meadow')) {
                // Plains should be smoother
                combinedNoise = noise1 * 0.7 + noise2 * 0.3 + noise3 * 0.15 + noise4 * 0.1;
            } else if (currentBiomeKey.includes('desert') || currentBiomeKey.includes('dunes')) {
                // Deserts have rolling dunes
                combinedNoise = noise1 * 0.8 + noise2 * 0.6 + noise3 * 0.2 + noise4 * 0.1;
            } else if (currentBiomeKey.includes('ocean') || currentBiomeKey.includes('lake')) {
                // Water areas should be relatively flat with subtle variation
                combinedNoise = noise1 * 0.5 + noise2 * 0.2 + noise3 * 0.1 + noise4 * 0.05;
            } else {
                // Default balanced combination
                combinedNoise = noise1 + noise2 * 0.5 + noise3 * 0.25 + noise4 * 0.125;
            }
            
            return Math.floor(biomeToUse.baseHeight + combinedNoise * biomeToUse.heightVariation);
        } else {
            // Enhanced blending for smoother transitions
            const blendRadius = (currentBiome.transition === "Full") ? 8 : 4;
            let sumHeights = 0;
            let totalWeight = 0;
            
            // Use a step size to reduce calculations
            const step = Math.max(1, Math.floor(blendRadius / 4));
            
            for (let dx = -blendRadius; dx <= blendRadius; dx += step) {
                for (let dz = -blendRadius; dz <= blendRadius; dz += step) {
                    const sampleBiomeKey = getBiomeForChunk(globalX + dx, globalZ + dz);
                    const sampleBiome = BIOMES[sampleBiomeKey];
                    
                    // Enhanced sampling with multiple octaves for each sample point
                    let sampleBiomeToUse = sampleBiome;
                    
                    // Only check for edge properties if the sample biome has them
                    if (sampleBiome.edges) {
                        const sampleEdgeInfo = isAtBiomeEdge(globalX + dx, globalZ + dz);
                        if (sampleEdgeInfo.isEdge) {
                            const sampleBlendFactor = sampleBiome.edges.blend ? 
                                Math.min(1, sampleEdgeInfo.edgeDistance * (sampleBiome.edges.blend * 0.1)) : 
                                sampleEdgeInfo.edgeDistance;
                            
                            sampleBiomeToUse = {
                                baseHeight: lerp(sampleBiome.edges.baseHeight, sampleBiome.baseHeight, sampleBlendFactor),
                                heightVariation: lerp(sampleBiome.edges.heightVariation, sampleBiome.heightVariation, sampleBlendFactor),
                                frequency: sampleBiome.edges.frequency || sampleBiome.frequency
                            };
                        }
                    }
                    
                    // Multi-octave noise for sample points too
                    const sScale1 = sampleBiomeToUse.frequency;
                    const sScale2 = sampleBiomeToUse.frequency * 2.5;
                    const sScale3 = sampleBiomeToUse.frequency * 6.0;
                    
                    const sNoise1 = noiseGenerator.noise((globalX + dx) * sScale1, 0, (globalZ + dz) * sScale1);
                    const sNoise2 = noiseGenerator.noise((globalX + dx) * sScale2, 100, (globalZ + dz) * sScale2) * 0.5;
                    const sNoise3 = noiseGenerator.noise((globalX + dx) * sScale3, 200, (globalZ + dz) * sScale3) * 0.25;
                    
                    let sCombinedNoise;
                    if (sampleBiomeKey.includes('mountain') || sampleBiomeKey.includes('peaks') || sampleBiomeKey.includes('hills')) {
                        sCombinedNoise = sNoise1 + sNoise2 * 0.8 + sNoise3 * 0.4;
                    } else if (sampleBiomeKey.includes('plains') || sampleBiomeKey.includes('meadow')) {
                        sCombinedNoise = sNoise1 * 0.7 + sNoise2 * 0.3 + sNoise3 * 0.15;
                    } else if (sampleBiomeKey.includes('ocean') || sampleBiomeKey.includes('lake')) {
                        sCombinedNoise = sNoise1 * 0.5 + sNoise2 * 0.2 + sNoise3 * 0.1;
                    } else {
                        sCombinedNoise = sNoise1 + sNoise2 * 0.5 + sNoise3 * 0.25;
                    }
                    
                    const sampleHeight = sampleBiomeToUse.baseHeight + sCombinedNoise * sampleBiomeToUse.heightVariation;
                    const distance = Math.sqrt(dx * dx + dz * dz);
                    // Enhanced weight calculation for smoother blending
                    const weight = Math.max(0.1, Math.pow(blendRadius - distance + 1, 1.5));
                    sumHeights += sampleHeight * weight;
                    totalWeight += weight;
                }
            }
            return Math.floor(sumHeights / totalWeight);
        }
    }

    // Generate terrain - enhanced with smooth biome transitions
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const globalX = cx * CHUNK_SIZE + x;
            const globalZ = cz * CHUNK_SIZE + z;
            
            // Use enhanced biome selection with transitions
            const biomeKey = getBiomeWithTransitions(globalX, globalZ);
            const biome = BIOMES[biomeKey];
            const h = getHeightWithBiomeForChunk(globalX, globalZ);
            
            // Get edge info once (it's cached now)
            const edgeInfo = isAtBiomeEdge(globalX, globalZ);
            
            // Enhanced layer blending for smooth transitions
            let layersToUse = biome.layers;
            let defaultLayerToUse = biome.defaultLayer;
            
            // Check for biome transition blending
            if (BIOME_ADJACENCY && edgeInfo.isEdge) {
                const nearbyBiomeKey = edgeInfo.nearbyBiomeKey;
                const transitionType = getBiomeTransitionType(biomeKey, nearbyBiomeKey);
                
                if (transitionType === 'buffered' || transitionType === 'direct') {
                    const nearbyBiome = BIOMES[nearbyBiomeKey];
                    const blendFactor = Math.min(0.5, edgeInfo.edgeDistance);
                    
                    // Blend layers between biomes for smoother transitions
                    if (nearbyBiome && nearbyBiome.layers && Math.random() < blendFactor) {
                        // Occasionally use nearby biome's layers for natural mixing
                        if (nearbyBiome.layers.length > 0 && biome.layers.length > 0) {
                            // Mix the top layers
                            layersToUse = [...biome.layers];
                            if (layersToUse.length > 0 && nearbyBiome.layers.length > 0) {
                                layersToUse[0] = nearbyBiome.layers[0]; // Use nearby biome's top layer
                            }
                        }
                    }
                }
            }
            
            if (edgeInfo.isEdge && biome.edges) {
                // If we're using edge properties, check if we should use the edge's layers or default ones
                if (biome.edges.layers && biome.edges.layers !== "default") {
                    layersToUse = biome.edges.layers;
                }
                
                if (biome.edges.defaultLayer && biome.edges.defaultLayer !== "default") {
                    defaultLayerToUse = biome.edges.defaultLayer;
                }
            }

            // Fill terrain layers - optimized
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
                    
                    // Optimized block placement
                    for (let y = remaining - thickness; y < remaining; y++) {
                        if (y >= 0 && y < WORLD_HEIGHT) {
                            data[x][y][z] = blockType;
                        }
                    }
                    remaining -= thickness;
                }
            }
            
            // Fill remaining with default layer - optimized
            const defaultBlockType = BLOCK_TYPES[defaultLayerToUse];
            for (let y = 0; y < remaining; y++) {
                if (y < WORLD_HEIGHT) {
                    data[x][y][z] = defaultBlockType;
                }
            }

            // Handle water fill for ocean biomes - optimized
            if (biome.fill) {
                const fillHeight = Math.min(biome.fill.height, WORLD_HEIGHT);
                const fillBlockType = BLOCK_TYPES[biome.fill.type];
                for (let y = 0; y < fillHeight; y++) {
                    if (data[x][y][z] === 0) {
                        data[x][y][z] = fillBlockType;
                    }
                }
            }

            // Generate structures based on biome - optimized
            if (biome.structures && StructureGenerators) {
                for (let i = 0; i < biome.structures.length; i++) {
                    const structure = biome.structures[i];
                    // Pre-calculate structure chance and only check if generator exists
                    if (StructureGenerators[structure.type] && Math.random() < (structure.frequency / 100)) {
                        StructureGenerators[structure.type](data, x, h, z);
                    }
                }
            }
        }
    }

    // Store chunk in storage for neighbor lookups
    chunkStorage.set(`${cx},${cz}`, data);

    // Check if we need to update any neighboring chunks
    const neighbors = [
        [cx - 1, cz], [cx + 1, cz],
        [cx, cz - 1], [cx, cz + 1]
    ];
    
    // Queue updates for neighbors if they exist
    for (const [ncx, ncz] of neighbors) {
        const nKey = `${ncx},${ncz}`;
        if (chunkStorage.has(nKey)) {
            self.postMessage({
                type: "chunkUpdated",
                cx: ncx,
                cz: ncz,
                chunkData: chunkStorage.get(nKey)
            });
        }
    }

    const totalTime = performance.now() - startTime;
    
    // Optional: Log performance metrics (comment out in production)
    if (totalTime > 50) { // Only log slow chunks
        console.log(`Chunk (${cx},${cz}) generation took ${totalTime.toFixed(2)}ms (biome calc: ${biomeCalcTime.toFixed(2)}ms)`);
    }

    return data;
}

// Message handler
self.onmessage = function(e) {
    const { cx, cz, constants, type, modifiedChunk, requestGeometry } = e.data;
    
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
                }, [
                    geometryData.opaque.vertices.buffer,
                    geometryData.opaque.indices.buffer,
                    geometryData.opaque.uvs.buffer,
                    geometryData.opaque.colors.buffer,
                    geometryData.transparent.vertices.buffer,
                    geometryData.transparent.indices.buffer,
                    geometryData.transparent.uvs.buffer,
                    geometryData.transparent.colors.buffer
                ]);
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
        
        // Build geometry data in the worker
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
        }, [
            geometryData.opaque.vertices.buffer,
            geometryData.opaque.indices.buffer,
            geometryData.opaque.uvs.buffer,
            geometryData.opaque.colors.buffer,
            geometryData.transparent.vertices.buffer,
            geometryData.transparent.indices.buffer,
            geometryData.transparent.uvs.buffer,
            geometryData.transparent.colors.buffer
        ]);
        
        // Then update all existing neighbors that might need re-rendering
        for (const [ncx, ncz] of neighbors) {
            const nKey = `${ncx},${ncz}`;
            if (chunkStorage.has(nKey)) {
                const neighborData = chunkStorage.get(nKey);
                const neighborGeom = buildChunkGeometry(neighborData, ncx, ncz);
                
                self.postMessage({
                    type: "chunkUpdated",
                    cx: ncx,
                    cz: ncz,
                    geometryData: neighborGeom
                }, [
                    neighborGeom.opaque.vertices.buffer,
                    neighborGeom.opaque.indices.buffer,
                    neighborGeom.opaque.uvs.buffer,
                    neighborGeom.opaque.colors.buffer,
                    neighborGeom.transparent.vertices.buffer,
                    neighborGeom.transparent.indices.buffer,
                    neighborGeom.transparent.uvs.buffer,
                    neighborGeom.transparent.colors.buffer
                ]);
            }
        }
        return;
    }
    
    // If geometry was requested, build and return it
    if (requestGeometry) {
        const geometryData = buildChunkGeometry(chunkData, cx, cz);
        
        self.postMessage({ 
            cx, 
            cz, 
            geometryData 
        }, [
            geometryData.opaque.vertices.buffer,
            geometryData.opaque.indices.buffer,
            geometryData.opaque.uvs.buffer,
            geometryData.opaque.colors.buffer,
            geometryData.transparent.vertices.buffer,
            geometryData.transparent.indices.buffer,
            geometryData.transparent.uvs.buffer,
            geometryData.transparent.colors.buffer
        ]);
    } else {
        // Just send the chunk data, legacy behavior
        self.postMessage({ cx, cz, chunkData });
    }
};