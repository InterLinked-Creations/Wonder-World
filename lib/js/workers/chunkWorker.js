// Chunk Worker - Simplified flat-world generator
// Note: We'll receive needed variables and constants from the main thread

let CHUNK_SIZE, WORLD_HEIGHT, BLOCK_TYPES;
let blockColors; // Will be populated from main thread

// Add chunk storage
const chunkStorage = new Map();
const neighborChunks = new Map(); // Store neighboring chunks for proper culling

// Basic utilities
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

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
// 1. UNLOADED CHUNKS: Show faces at chunk boundaries (assume air until proven otherwise)
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
    // RULE: If neighbor chunk isn't loaded, treat it as air and show the face
    // This prevents missing faces at chunk boundaries
    if (!neighborChunkLoaded) {
        return false; // Show face when neighbor chunk not loaded (assume air)
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

// Removed noise and seed-dependent utilities as terrain is now flat

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

// Main chunk generation function (flat world)
function generateChunkData(cx, cz) {
    // Create the data array with chunk coordinates
    const data = new Array(CHUNK_SIZE);
    data.chunkX = cx;
    data.chunkZ = cz;
    const heightMap = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE);

    // Choose simple flat height
    const GROUND_LEVEL = Math.max(4, Math.floor(WORLD_HEIGHT * 0.25));

    // Resolve common block IDs with fallbacks
    const id = (name) => (BLOCK_TYPES && BLOCK_TYPES[name] !== undefined) ? BLOCK_TYPES[name] : undefined;
    const stoneId = id('stone') ?? id('STONE') ?? id('rock') ?? 1;

    for (let x = 0; x < CHUNK_SIZE; x++) {
        data[x] = [];
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const idx = z * CHUNK_SIZE + x;
            const topY = Math.min(GROUND_LEVEL - 1, WORLD_HEIGHT - 1);
            heightMap[idx] = topY;

            for (let y = 0; y <= topY; y++) {
                if (!data[x][y]) data[x][y] = [];
                let blockType = stoneId;
 
                data[x][y][z] = blockType;
            }
        }
    }

    data.heightMap = heightMap;

    // Store chunk
    const key = `${cx},${cz}`;
    chunkStorage.set(key, data);
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
        blockColors = constants.blockColors;
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