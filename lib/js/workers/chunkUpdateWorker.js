// Dedicated Chunk Update Worker
// Purpose: receive modified chunk data (from block place/break), rebuild geometry for that chunk
// and return geometryData back to the main thread. This worker is single-purpose and avoids
// conflicts between chunk generation workers when applying player edits.

let CHUNK_SIZE, WORLD_HEIGHT, BLOCK_TYPES;
let blockColors;

const faces = [
    { dir: [0, 0, 1], vertices: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]] }, // front
    { dir: [0, 0, -1], vertices: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]] }, // back
    { dir: [1, 0, 0], vertices: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]] }, // right
    { dir: [-1,0,0], vertices: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]] }, // left
    { dir: [0,1,0], vertices: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]] }, // top
    { dir: [0,-1,0], vertices: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]] }  // bottom
];

const faceNames = ["front","back","right","left","top","bottom"];

function getBlockNameFromType(blockType) {
    if (!BLOCK_TYPES) return "unknown";
    return Object.keys(BLOCK_TYPES).find(k => BLOCK_TYPES[k] === blockType) || "unknown";
}

function getBlockProperties(blockType) {
    if (!blockType) return null;
    const name = getBlockNameFromType(blockType);
    if (!blockColors) return { transparency: 1, color: { r:1,g:1,b:1 } };
    return blockColors[name] || { transparency: 1, color: { r:1,g:1,b:1 } };
}

function isTransparentBlock(props) {
    if (!props) return false;
    return (props.transparency !== undefined && props.transparency < 1) || !!props.seeThrough;
}

function shouldCullFace(blockType, neighborType, neighborChunkLoaded, blockProps, neighborProps) {
    // If neighbor chunk not loaded, assume air and show the face
    if (!neighborChunkLoaded) return false;
    if (!neighborType || neighborType === 0) return false;
    if (!blockProps) blockProps = getBlockProperties(blockType);
    if (!neighborProps) neighborProps = getBlockProperties(neighborType);
    if (!blockProps || !neighborProps) return true;
    const curTrans = isTransparentBlock(blockProps);
    const neighTrans = isTransparentBlock(neighborProps);
    if (!curTrans) {
        if (!neighTrans) return true;
        return false;
    }
    if (curTrans) {
        if (!neighTrans) return false;
        if (blockType === neighborType) return true;
        return false;
    }
    return false;
}

function buildChunkGeometry(chunkData, cx, cz) {
    const oVertices = [], oIndices = [], oUVs = [], oColors = [];
    let oVertexCount = 0;
    const tVertices = [], tIndices = [], tUVs = [], tColors = [];
    let tVertexCount = 0;
    const texturedGeometries = {};

    // Pre-cache neighbors - for update worker we assume neighbors are loaded in main thread
    // but we cannot access them here; treat out-of-bounds neighbor chunks as unloaded

    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let y = 0; y < WORLD_HEIGHT; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const col = chunkData[x];
                if (!col) continue;
                const row = col[y];
                if (!row) continue;
                const blockType = row[z] || 0;
                if (blockType === 0) continue;
                const blockName = getBlockNameFromType(blockType);
                const props = blockColors && blockColors[blockName] ? blockColors[blockName] : { color: { r:1,g:1,b:1 }, transparency: 1 };

                for (let f = 0; f < faces.length; f++) {
                    const face = faces[f];
                    const nx = x + face.dir[0];
                    const ny = y + face.dir[1];
                    const nz = z + face.dir[2];

                    let neighbor = 0;
                    let neighborChunkLoaded = true; // Assume neighbor within same chunk
                    if (ny < 0 || ny >= WORLD_HEIGHT) {
                        neighbor = 0;
                    } else if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) {
                        // We don't have neighbor chunk data here; treat as unloaded -> cull
                        neighborChunkLoaded = false;
                    } else {
                        const ncol = chunkData[nx];
                        neighbor = (ncol && ncol[ny] && ncol[ny][nz]) || 0;
                    }

                    const neighborProps = neighbor ? getBlockProperties(neighbor) : null;
                    if (shouldCullFace(blockType, neighbor, neighborChunkLoaded, props, neighborProps)) continue;

                    // Check for textured faces
                    const faceName = faceNames[f];
                    const hasFaceSpecificTexture = props.faces && props.faces[faceName] && props.faces[faceName].hasTexture;
                    const hasDefaultTexture = props.hasDefaultTexture;
                    if (hasFaceSpecificTexture || hasDefaultTexture) {
                        const textureKey = blockName + (hasFaceSpecificTexture ? '_' + faceName : '');
                        if (!texturedGeometries[textureKey]) texturedGeometries[textureKey] = { vertices: [], indices: [], uvs: [], vertexCount: 0, blockName: blockName, faceName: hasFaceSpecificTexture ? faceName : null, color: props.color || { r:1,g:1,b:1 } };
                        const geo = texturedGeometries[textureKey];
                        for (let i = 0; i < 4; i++) {
                            const v = face.vertices[i];
                            geo.vertices.push(cx*CHUNK_SIZE + x + v[0], y + v[1], cz*CHUNK_SIZE + z + v[2]);
                        }
                        geo.uvs.push(0,0,1,0,1,1,0,1);
                        geo.indices.push(geo.vertexCount, geo.vertexCount+1, geo.vertexCount+2, geo.vertexCount, geo.vertexCount+2, geo.vertexCount+3);
                        geo.vertexCount += 4;
                        continue;
                    }

                    // Opaque vs transparent (non-textured)
                    const baseColor = props.color || { r:1,g:1,b:1 };
                    if ((props.transparency ?? 1) === 1) {
                        for (let i=0;i<4;i++) {
                            const v = face.vertices[i];
                            oVertices.push(cx*CHUNK_SIZE + x + v[0], y + v[1], cz*CHUNK_SIZE + z + v[2]);
                            oColors.push(baseColor.r, baseColor.g, baseColor.b);
                        }
                        oUVs.push(0,0,1,0,1,1,0,1);
                        oIndices.push(oVertexCount, oVertexCount+1, oVertexCount+2, oVertexCount, oVertexCount+2, oVertexCount+3);
                        oVertexCount += 4;
                    } else {
                        for (let i=0;i<4;i++) {
                            const v = face.vertices[i];
                            tVertices.push(cx*CHUNK_SIZE + x + v[0], y + v[1], cz*CHUNK_SIZE + z + v[2]);
                            tColors.push(baseColor.r, baseColor.g, baseColor.b);
                        }
                        tUVs.push(0,0,1,0,1,1,0,1);
                        tIndices.push(tVertexCount, tVertexCount+1, tVertexCount+2, tVertexCount, tVertexCount+2, tVertexCount+3);
                        tVertexCount += 4;
                    }
                }
            }
        }
    }

    const textured = [];
    for (const [key, geo] of Object.entries(texturedGeometries)) {
        textured.push({ key, vertices: new Float32Array(geo.vertices), indices: new Uint32Array(geo.indices), uvs: new Float32Array(geo.uvs), blockName: geo.blockName, faceName: geo.faceName, color: geo.color });
    }
    const geometryData = {
        opaque: { vertices: new Float32Array(oVertices), indices: new Uint32Array(oIndices), uvs: new Float32Array(oUVs), colors: new Float32Array(oColors) },
        transparent: { vertices: new Float32Array(tVertices), indices: new Uint32Array(tIndices), uvs: new Float32Array(tUVs), colors: new Float32Array(tColors) },
        textured: textured
    };
    return geometryData;
}

// Build geometry only for a small neighborhood around modified positions
function buildGeometryDelta(chunkData, cx, cz, modifiedPositions) {
    const oVertices = [], oIndices = [], oUVs = [], oColors = [];
    let oVertexCount = 0;
    const tVertices = [], tIndices = [], tUVs = [], tColors = [];
    let tVertexCount = 0;
    const texturedGeometries = {};

    // Build a set of positions to check (include neighbors because faces may change)
    const checkSet = new Set();
    for (const pos of modifiedPositions) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const nx = pos.x + dx, ny = pos.y + dy, nz = pos.z + dz;
                    if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE || ny < 0 || ny >= WORLD_HEIGHT) continue;
                    checkSet.add(`${nx},${ny},${nz}`);
                }
            }
        }
    }

    for (const key of checkSet) {
        const [x,y,z] = key.split(',').map(Number);
        const col = chunkData[x];
        if (!col) continue;
        const row = col[y];
        const blockType = row ? (row[z] || 0) : 0;
        if (blockType === 0) continue;
        const blockName = getBlockNameFromType(blockType);
        const props = blockColors && blockColors[blockName] ? blockColors[blockName] : { color: { r:1,g:1,b:1 }, transparency: 1 };

        for (let f = 0; f < faces.length; f++) {
            const face = faces[f];
            const nx = x + face.dir[0];
            const ny = y + face.dir[1];
            const nz = z + face.dir[2];

            let neighbor = 0;
            let neighborChunkLoaded = true;
            if (ny < 0 || ny >= WORLD_HEIGHT) {
                neighbor = 0;
            } else if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) {
                neighborChunkLoaded = false;
            } else {
                const ncol = chunkData[nx];
                neighbor = (ncol && ncol[ny] && ncol[ny][nz]) || 0;
            }

            const neighborProps = neighbor ? getBlockProperties(neighbor) : null;
            if (shouldCullFace(blockType, neighbor, neighborChunkLoaded, props, neighborProps)) continue;

            // Check for textured faces in delta
            const faceName = faceNames[f];
            const hasFaceSpecificTexture = props.faces && props.faces[faceName] && props.faces[faceName].hasTexture;
            const hasDefaultTexture = props.hasDefaultTexture;
            if (hasFaceSpecificTexture || hasDefaultTexture) {
                const textureKey = blockName + (hasFaceSpecificTexture ? '_' + faceName : '');
                if (!texturedGeometries[textureKey]) texturedGeometries[textureKey] = { vertices: [], indices: [], uvs: [], vertexCount: 0, blockName: blockName, faceName: hasFaceSpecificTexture ? faceName : null, color: props.color || { r:1,g:1,b:1 } };
                const geo = texturedGeometries[textureKey];
                for (let i = 0; i < 4; i++) {
                    const v = face.vertices[i];
                    geo.vertices.push(cx*CHUNK_SIZE + x + v[0], y + v[1], cz*CHUNK_SIZE + z + v[2]);
                }
                geo.uvs.push(0,0,1,0,1,1,0,1);
                geo.indices.push(geo.vertexCount, geo.vertexCount+1, geo.vertexCount+2, geo.vertexCount, geo.vertexCount+2, geo.vertexCount+3);
                geo.vertexCount += 4;
                continue;
            }

            const baseColor = props.color || { r:1,g:1,b:1 };
            if ((props.transparency ?? 1) === 1) {
                for (let i=0;i<4;i++) {
                    const v = face.vertices[i];
                    oVertices.push(cx*CHUNK_SIZE + x + v[0], y + v[1], cz*CHUNK_SIZE + z + v[2]);
                    oColors.push(baseColor.r, baseColor.g, baseColor.b);
                }
                oUVs.push(0,0,1,0,1,1,0,1);
                oIndices.push(oVertexCount, oVertexCount+1, oVertexCount+2, oVertexCount, oVertexCount+2, oVertexCount+3);
                oVertexCount += 4;
            } else {
                for (let i=0;i<4;i++) {
                    const v = face.vertices[i];
                    tVertices.push(cx*CHUNK_SIZE + x + v[0], y + v[1], cz*CHUNK_SIZE + z + v[2]);
                    tColors.push(baseColor.r, baseColor.g, baseColor.b);
                }
                tUVs.push(0,0,1,0,1,1,0,1);
                tIndices.push(tVertexCount, tVertexCount+1, tVertexCount+2, tVertexCount, tVertexCount+2, tVertexCount+3);
                tVertexCount += 4;
            }
        }
    }

    const textured = [];
    for (const [key, geo] of Object.entries(texturedGeometries)) {
        textured.push({ key, vertices: new Float32Array(geo.vertices), indices: new Uint32Array(geo.indices), uvs: new Float32Array(geo.uvs), blockName: geo.blockName, faceName: geo.faceName, color: geo.color });
    }
    const geometryData = {
        opaque: { vertices: new Float32Array(oVertices), indices: new Uint32Array(oIndices), uvs: new Float32Array(oUVs), colors: new Float32Array(oColors) },
        transparent: { vertices: new Float32Array(tVertices), indices: new Uint32Array(tIndices), uvs: new Float32Array(tUVs), colors: new Float32Array(tColors) },
        textured: textured
    };
    return geometryData;
}

function getTransferableBuffers(geometryData) {
    const buffers = [];
    if (geometryData.opaque) {
        buffers.push(geometryData.opaque.vertices.buffer);
        buffers.push(geometryData.opaque.indices.buffer);
        buffers.push(geometryData.opaque.uvs.buffer);
        buffers.push(geometryData.opaque.colors.buffer);
    }
    if (geometryData.transparent) {
        buffers.push(geometryData.transparent.vertices.buffer);
        buffers.push(geometryData.transparent.indices.buffer);
        buffers.push(geometryData.transparent.uvs.buffer);
        buffers.push(geometryData.transparent.colors.buffer);
    }
    if (geometryData.textured && Array.isArray(geometryData.textured)) {
        for (const t of geometryData.textured) {
            if (t.vertices) buffers.push(t.vertices.buffer);
            if (t.indices) buffers.push(t.indices.buffer);
            if (t.uvs) buffers.push(t.uvs.buffer);
        }
    }
    return buffers;
}

self.onmessage = function(e) {
    const { type, cx, cz, modifiedChunk, constants, requestGeometry } = e.data;
    if (constants) {
        CHUNK_SIZE = constants.CHUNK_SIZE;
        WORLD_HEIGHT = constants.WORLD_HEIGHT;
        BLOCK_TYPES = constants.BLOCK_TYPES;
        blockColors = constants.blockColors;
    }

    if (type === 'updateChunk' && modifiedChunk) {
        // If the message provides modifiedPositions, perform a fast delta rebuild
        if (e.data.modifiedPositions && Array.isArray(e.data.modifiedPositions) && e.data.modifiedPositions.length > 0) {
            // NOTE: delta rebuilds are available, but the main thread currently expects
            // full chunk geometry for replacement. To avoid visual corruption we perform
            // a full rebuild here for now. Delta-only responses can be supported later
            // by merging on the main thread.
            const geometryData = buildChunkGeometry(modifiedChunk, cx, cz);
            self.postMessage({ type: 'chunkUpdated', cx, cz, geometryData }, getTransferableBuffers(geometryData));
            return;
        }

        // Fallback: full rebuild
        const geometryData = buildChunkGeometry(modifiedChunk, cx, cz);
        self.postMessage({ type: 'chunkUpdated', cx, cz, geometryData }, getTransferableBuffers(geometryData));
        return;
    }

    // If a raw chunkData and requestGeometry is present, build geometry similarly
    if (requestGeometry && e.data.chunkData) {
        const geom = buildChunkGeometry(e.data.chunkData, cx, cz);
        self.postMessage({ cx, cz, geometryData: geom }, getTransferableBuffers(geom));
    }
};
