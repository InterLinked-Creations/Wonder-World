// Chunk Worker
// Note: We'll receive needed variables and constants from the main thread

let CHUNK_SIZE, WORLD_HEIGHT, BLOCK_TYPES, BIOMES, worldSeed, StructureGenerators;
let blockColors; // Will be populated from main thread

// Add chunk storage
const chunkStorage = new Map();
const neighborChunks = new Map(); // Store neighboring chunks for proper culling

// Helper function to get block properties
function getBlockProperties(blockType) {
    if (!blockType) return null;
    // Convert block type number to name
    const blockName = Object.keys(BLOCK_TYPES).find(key => BLOCK_TYPES[key] === blockType);
    return blockColors[blockName] || { transparency: 1 };
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
    // Create a single noise generator instance for this chunk
    const noiseGenerator = new ImprovedNoise();
    
    // Create the data array with chunk coordinates
    const data = Array(CHUNK_SIZE).fill().map(() => 
        Array(WORLD_HEIGHT).fill().map(() => 
            Array(CHUNK_SIZE).fill(0)
        )
    );
    // Store chunk coordinates directly on the data object
    data.chunkX = cx;
    data.chunkZ = cz;

    // Helper function to get biome with shared noise generator
    function getBiomeForChunk(globalX, globalZ) {
        let n = (noiseGenerator.noise(globalX * 0.001, 0, globalZ * 0.001) + 1) / 2;
        let total = 0;
        for (const key in BIOMES) {
            total += BIOMES[key].rarity * BIOMES[key].size;
        }
        let threshold = n * total;
        let cumulative = 0;
        for (const key in BIOMES) {
            cumulative += BIOMES[key].rarity * BIOMES[key].size;
            if (threshold <= cumulative) {
                return key;
            }
        }
        return "ocean";
    }

    // Helper function to get height with shared noise generator
    function getHeightWithBiomeForChunk(globalX, globalZ) {
        const currentBiomeKey = getBiomeForChunk(globalX, globalZ);
        const currentBiome = BIOMES[currentBiomeKey];
        
        if (currentBiome.transition === "None") {
            const nPrimary = noiseGenerator.noise(globalX * currentBiome.frequency, 0, globalZ * currentBiome.frequency);
            return Math.floor(currentBiome.baseHeight + nPrimary * currentBiome.heightVariation);
        } else {
            const blendRadius = (currentBiome.transition === "Full") ? 10 : 5;
            let sumHeights = 0;
            let totalWeight = 0;
            for (let dx = -blendRadius; dx <= blendRadius; dx++) {
                for (let dz = -blendRadius; dz <= blendRadius; dz++) {
                    const sampleBiomeKey = getBiomeForChunk(globalX + dx, globalZ + dz);
                    const sampleBiome = BIOMES[sampleBiomeKey];
                    const nSample = noiseGenerator.noise((globalX + dx) * sampleBiome.frequency, 0, (globalZ + dz) * sampleBiome.frequency);
                    const sampleHeight = sampleBiome.baseHeight + nSample * sampleBiome.heightVariation;
                    const distance = Math.sqrt(dx * dx + dz * dz);
                    const weight = Math.max(0, blendRadius - distance + 1);
                    sumHeights += sampleHeight * weight;
                    totalWeight += weight;
                }
            }
            return Math.floor(sumHeights / totalWeight);
        }
    }

    // Generate terrain
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const globalX = cx * CHUNK_SIZE + x;
            const globalZ = cz * CHUNK_SIZE + z;
            const biomeKey = getBiomeForChunk(globalX, globalZ);
            const biome = BIOMES[biomeKey];
            const h = getHeightWithBiomeForChunk(globalX, globalZ);

            // Fill terrain layers
            let remaining = h;
            if (biome.layers && biome.layers.length > 0) {
                for (const layer of biome.layers) {
                    let thickness = 0;
                    const thicknessDef = layer.number;
                    if (typeof thicknessDef === "string") {
                        if (thicknessDef.indexOf("-") !== -1) {
                            const [min, max] = thicknessDef.split("-").map(Number);
                            thickness = Math.floor(Math.random() * (max - min + 1)) + min;
                        } else {
                            thickness = parseInt(thicknessDef);
                        }
                    } else {
                        thickness = thicknessDef;
                    }
                    thickness = Math.min(thickness, remaining);
                    
                    for (let y = remaining - thickness; y < remaining; y++) {
                        if (y >= 0 && y < WORLD_HEIGHT) {
                            data[x][y][z] = BLOCK_TYPES[layer.type];
                        }
                    }
                    remaining -= thickness;
                    if (remaining <= 0) break;
                }
            }
            
            // Fill remaining with default layer
            for (let y = 0; y < remaining; y++) {
                if (y >= 0 && y < WORLD_HEIGHT) {
                    data[x][y][z] = BLOCK_TYPES[biome.defaultLayer];
                }
            }

            // Handle water fill for ocean biomes
            if (biome.fill) {
                const fillHeight = Math.min(biome.fill.height, WORLD_HEIGHT);
                for (let y = 0; y < fillHeight; y++) {
                    if (data[x][y][z] === 0) {
                        data[x][y][z] = BLOCK_TYPES[biome.fill.type];
                    }
                }
            }

            // Generate structures based on biome
            if (biome.structures) {
                for (const structure of biome.structures) {
                    // Convert frequency to decimal (e.g., 0.5 -> 0.005 for 0.5%)
                    const structureChance = structure.frequency / 100;
                    // Use structure frequency as probability
                    if (Math.random() < structureChance) {
                        // Only generate if we have the generator for this structure type
                        if (StructureGenerators && StructureGenerators[structure.type]) {
                            StructureGenerators[structure.type](data, x, h, z);
                        }
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

    return data;
}

// Message handler
self.onmessage = function(e) {
    const { cx, cz, constants, type, modifiedChunk } = e.data;
    
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
                self.postMessage({
                    type: "chunkUpdated",
                    cx: updateCx,
                    cz: updateCz,
                    chunkData: chunkToUpdate
                });
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
        
        // Convert string functions back to actual functions
        StructureGenerators = {};
        for (const [key, fnString] of Object.entries(constants.StructureGenerators)) {
            StructureGenerators[key] = new Function('return ' + fnString)();
        }
    }

    // Check if we have this chunk stored
    const key = `${cx},${cz}`;
    let chunkData = chunkStorage.get(key);
    
    // If not in storage, generate new chunk
    if (!chunkData) {
        chunkData = generateChunkData(cx, cz);
        chunkStorage.set(key, chunkData);
        
        // Get all neighboring chunks that need updating
        const neighbors = [
            [cx - 1, cz], [cx + 1, cz],
            [cx, cz - 1], [cx, cz + 1],
            [cx - 1, cz - 1], [cx + 1, cz - 1],
            [cx - 1, cz + 1], [cx + 1, cz + 1]
        ];
        
        // First send the new chunk
        self.postMessage({ cx, cz, chunkData });
        
        // Then update all existing neighbors
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
        return;
    }
    
    // Send back the chunk
    self.postMessage({ cx, cz, chunkData });
};