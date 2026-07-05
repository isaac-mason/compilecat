// Faithful VERBATIM copies of mathcat pure functions, for the corpus differential
// in real-world.test.ts. Each is wrapped in @optimize + checked compiled ≡ source
// over random inputs. mathcat is third-party and never modified; these are COPIES.
// Extracted from mathcat@0.0.13 dist.
export const MATHCAT_CORPUS = [
    // ---- vec2 ----
    {
        module: 'vec2',
        fn: 'add',
        out: 2,
        args: [2, 2],
        src: 'function add(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; return out; }',
    },
    {
        module: 'vec2',
        fn: 'addScalar',
        out: 2,
        args: [2, 'n'],
        src: 'function addScalar(out, a, b) { out[0] = a[0] + b; out[1] = a[1] + b; return out; }',
    },
    {
        module: 'vec2',
        fn: 'subtract',
        out: 2,
        args: [2, 2],
        src: 'function subtract(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; return out; }',
    },
    {
        module: 'vec2',
        fn: 'multiply',
        out: 2,
        args: [2, 2],
        src: 'function multiply(out, a, b) { out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; return out; }',
    },
    {
        module: 'vec2',
        fn: 'divide',
        out: 2,
        args: [2, 2],
        src: 'function divide(out, a, b) { out[0] = a[0] / b[0]; out[1] = a[1] / b[1]; return out; }',
    },
    {
        module: 'vec2',
        fn: 'ceil',
        out: 2,
        args: [2],
        src: 'function ceil(out, a) { out[0] = Math.ceil(a[0]); out[1] = Math.ceil(a[1]); return out; }',
    },
    {
        module: 'vec2',
        fn: 'floor',
        out: 2,
        args: [2],
        src: 'function floor(out, a) { out[0] = Math.floor(a[0]); out[1] = Math.floor(a[1]); return out; }',
    },
    {
        module: 'vec2',
        fn: 'min',
        out: 2,
        args: [2, 2],
        src: 'function min(out, a, b) { out[0] = Math.min(a[0], b[0]); out[1] = Math.min(a[1], b[1]); return out; }',
    },
    {
        module: 'vec2',
        fn: 'max',
        out: 2,
        args: [2, 2],
        src: 'function max(out, a, b) { out[0] = Math.max(a[0], b[0]); out[1] = Math.max(a[1], b[1]); return out; }',
    },
    {
        module: 'vec2',
        fn: 'scale',
        out: 2,
        args: [2, 'n'],
        src: 'function scale(out, a, b) { out[0] = a[0] * b; out[1] = a[1] * b; return out; }',
    },
    {
        module: 'vec2',
        fn: 'scaleAndAdd',
        out: 2,
        args: [2, 2, 'n'],
        src: 'function scaleAndAdd(out, a, b, scale) { out[0] = a[0] + b[0] * scale; out[1] = a[1] + b[1] * scale; return out; }',
    },
    {
        module: 'vec2',
        fn: 'distance',
        out: 0,
        args: [2, 2],
        src: 'function distance(a, b) { const x = b[0] - a[0]; const y = b[1] - a[1]; return Math.sqrt(x * x + y * y); }',
    },
    {
        module: 'vec2',
        fn: 'squaredDistance',
        out: 0,
        args: [2, 2],
        src: 'function squaredDistance(a, b) { const x = b[0] - a[0]; const y = b[1] - a[1]; return x * x + y * y; }',
    },
    {
        module: 'vec2',
        fn: 'length',
        out: 0,
        args: [2],
        src: 'function length(a) { const x = a[0]; const y = a[1]; return Math.sqrt(x * x + y * y); }',
    },
    {
        module: 'vec2',
        fn: 'squaredLength',
        out: 0,
        args: [2],
        src: 'function squaredLength(a) { const x = a[0]; const y = a[1]; return x * x + y * y; }',
    },
    {
        module: 'vec2',
        fn: 'negate',
        out: 2,
        args: [2],
        src: 'function negate(out, a) { out[0] = -a[0]; out[1] = -a[1]; return out; }',
    },
    {
        module: 'vec2',
        fn: 'inverse',
        out: 2,
        args: [2],
        src: 'function inverse(out, a) { out[0] = 1.0 / a[0]; out[1] = 1.0 / a[1]; return out; }',
    },
    {
        module: 'vec2',
        fn: 'normalize',
        out: 2,
        args: [2],
        src: `function normalize(out, a) {
    const x = a[0];
    const y = a[1];
    let len = x * x + y * y;
    if (len > 0) {
        //TODO: evaluate use of glm_invsqrt here?
        len = 1 / Math.sqrt(len);
    }
    out[0] = a[0] * len;
    out[1] = a[1] * len;
    return out;
}`,
    },
    {
        module: 'vec2',
        fn: 'dot',
        out: 0,
        args: [2, 2],
        src: 'function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }',
    },
    {
        module: 'vec2',
        fn: 'cross',
        out: 3,
        args: [2, 2],
        src: `function cross(out, a, b) {
    const z = a[0] * b[1] - a[1] * b[0];
    out[0] = out[1] = 0;
    out[2] = z;
    return out;
}`,
    },
    {
        module: 'vec2',
        fn: 'lerp',
        out: 2,
        args: [2, 2, 'n'],
        src: 'function lerp(out, a, b, t) { const ax = a[0]; const ay = a[1]; out[0] = ax + t * (b[0] - ax); out[1] = ay + t * (b[1] - ay); return out; }',
    },
    {
        module: 'vec2',
        fn: 'transformMat2',
        out: 2,
        args: [2, 4],
        src: 'function transformMat2(out, a, m) { const x = a[0]; const y = a[1]; out[0] = m[0] * x + m[2] * y; out[1] = m[1] * x + m[3] * y; return out; }',
    },
    {
        module: 'vec2',
        fn: 'transformMat2d',
        out: 2,
        args: [2, 6],
        src: 'function transformMat2d(out, a, m) { const x = a[0]; const y = a[1]; out[0] = m[0] * x + m[2] * y + m[4]; out[1] = m[1] * x + m[3] * y + m[5]; return out; }',
    },
    {
        module: 'vec2',
        fn: 'transformMat3',
        out: 2,
        args: [2, 9],
        src: 'function transformMat3(out, a, m) { const x = a[0]; const y = a[1]; out[0] = m[0] * x + m[3] * y + m[6]; out[1] = m[1] * x + m[4] * y + m[7]; return out; }',
    },
    {
        module: 'vec2',
        fn: 'transformMat4',
        out: 2,
        args: [2, 16],
        src: 'function transformMat4(out, a, m) { const x = a[0]; const y = a[1]; out[0] = m[0] * x + m[4] * y + m[12]; out[1] = m[1] * x + m[5] * y + m[13]; return out; }',
    },
    {
        module: 'vec2',
        fn: 'rotate',
        out: 2,
        args: [2, 2, 'n'],
        src: `function rotate(out, a, b, rad) {
    //Translate point to the origin
    const p0 = a[0] - b[0];
    const p1 = a[1] - b[1];
    const sinC = Math.sin(rad);
    const cosC = Math.cos(rad);
    //perform rotation and translate to correct position
    out[0] = p0 * cosC - p1 * sinC + b[0];
    out[1] = p0 * sinC + p1 * cosC + b[1];
    return out;
}`,
    },
    {
        module: 'vec2',
        fn: 'angle',
        out: 0,
        args: [2, 2],
        src: `function angle(a, b) {
    const x1 = a[0];
    const y1 = a[1];
    const x2 = b[0];
    const y2 = b[1];
    // mag is the product of the magnitudes of a and b
    const mag = Math.sqrt((x1 * x1 + y1 * y1) * (x2 * x2 + y2 * y2));
    // mag &&.. short circuits if mag == 0
    const cosine = mag && (x1 * x2 + y1 * y2) / mag;
    // Math.min(Math.max(cosine, -1), 1) clamps the cosine between -1 and 1
    return Math.acos(Math.min(Math.max(cosine, -1), 1));
}`,
    },

    // ---- vec3 ----
    {
        module: 'vec3',
        fn: 'add',
        out: 3,
        args: [3, 3],
        src: 'function add(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out; }',
    },
    {
        module: 'vec3',
        fn: 'subtract',
        out: 3,
        args: [3, 3],
        src: 'function subtract(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; }',
    },
    {
        module: 'vec3',
        fn: 'multiply',
        out: 3,
        args: [3, 3],
        src: 'function multiply(out, a, b) { out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2]; return out; }',
    },
    {
        module: 'vec3',
        fn: 'divide',
        out: 3,
        args: [3, 3],
        src: 'function divide(out, a, b) { out[0] = a[0] / b[0]; out[1] = a[1] / b[1]; out[2] = a[2] / b[2]; return out; }',
    },
    {
        module: 'vec3',
        fn: 'scale',
        out: 3,
        args: [3, 'n'],
        src: 'function scale(out, a, b) { out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b; return out; }',
    },
    {
        module: 'vec3',
        fn: 'scaleAndAdd',
        out: 3,
        args: [3, 3, 'n'],
        src: 'function scaleAndAdd(out, a, b, scale) { out[0] = a[0] + b[0] * scale; out[1] = a[1] + b[1] * scale; out[2] = a[2] + b[2] * scale; return out; }',
    },
    {
        module: 'vec3',
        fn: 'min',
        out: 3,
        args: [3, 3],
        src: 'function min(out, a, b) { out[0] = Math.min(a[0], b[0]); out[1] = Math.min(a[1], b[1]); out[2] = Math.min(a[2], b[2]); return out; }',
    },
    {
        module: 'vec3',
        fn: 'max',
        out: 3,
        args: [3, 3],
        src: 'function max(out, a, b) { out[0] = Math.max(a[0], b[0]); out[1] = Math.max(a[1], b[1]); out[2] = Math.max(a[2], b[2]); return out; }',
    },
    {
        module: 'vec3',
        fn: 'distance',
        out: 0,
        args: [3, 3],
        src: 'function distance(a, b) { const x = b[0] - a[0]; const y = b[1] - a[1]; const z = b[2] - a[2]; return Math.sqrt(x * x + y * y + z * z); }',
    },
    {
        module: 'vec3',
        fn: 'squaredLength',
        out: 0,
        args: [3],
        src: 'function squaredLength(a) { const x = a[0]; const y = a[1]; const z = a[2]; return x * x + y * y + z * z; }',
    },
    {
        module: 'vec3',
        fn: 'negate',
        out: 3,
        args: [3],
        src: 'function negate(out, a) { out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; return out; }',
    },
    {
        module: 'vec3',
        fn: 'inverse',
        out: 3,
        args: [3],
        src: 'function inverse(out, a) { out[0] = 1.0 / a[0]; out[1] = 1.0 / a[1]; out[2] = 1.0 / a[2]; return out; }',
    },
    {
        module: 'vec3',
        fn: 'normalize',
        out: 3,
        args: [3],
        src: `function normalize(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    let len = x * x + y * y + z * z;
    if (len > 0) {
        //TODO: evaluate use of glm_invsqrt here?
        len = 1 / Math.sqrt(len);
    }
    out[0] = a[0] * len;
    out[1] = a[1] * len;
    out[2] = a[2] * len;
    return out;
}`,
    },
    {
        module: 'vec3',
        fn: 'dot',
        out: 0,
        args: [3, 3],
        src: 'function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }',
    },
    {
        module: 'vec3',
        fn: 'cross',
        out: 3,
        args: [3, 3],
        src: `function cross(out, a, b) {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const bx = b[0];
    const by = b[1];
    const bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
}`,
    },
    {
        module: 'vec3',
        fn: 'perpendicular',
        out: 3,
        args: [3],
        src: `function perpendicular(out, a) {
    if (Math.abs(a[0]) > Math.abs(a[1])) {
        const len = Math.sqrt(a[0] * a[0] + a[2] * a[2]);
        const invLen = 1.0 / len;
        out[0] = a[2] * invLen;
        out[1] = 0;
        out[2] = -a[0] * invLen;
    }
    else {
        const len = Math.sqrt(a[1] * a[1] + a[2] * a[2]);
        const invLen = 1.0 / len;
        out[0] = 0;
        out[1] = a[2] * invLen;
        out[2] = -a[1] * invLen;
    }
    return out;
}`,
    },
    {
        module: 'vec3',
        fn: 'lerp',
        out: 3,
        args: [3, 3, 'n'],
        src: 'function lerp(out, a, b, t) { const ax = a[0]; const ay = a[1]; const az = a[2]; out[0] = ax + t * (b[0] - ax); out[1] = ay + t * (b[1] - ay); out[2] = az + t * (b[2] - az); return out; }',
    },
    {
        module: 'vec3',
        fn: 'hermite',
        out: 3,
        args: [3, 3, 3, 3, 'n'],
        src: `function hermite(out, a, b, c, d, t) {
    const factorTimes2 = t * t;
    const factor1 = factorTimes2 * (2 * t - 3) + 1;
    const factor2 = factorTimes2 * (t - 2) + t;
    const factor3 = factorTimes2 * (t - 1);
    const factor4 = factorTimes2 * (3 - 2 * t);
    out[0] = a[0] * factor1 + b[0] * factor2 + c[0] * factor3 + d[0] * factor4;
    out[1] = a[1] * factor1 + b[1] * factor2 + c[1] * factor3 + d[1] * factor4;
    out[2] = a[2] * factor1 + b[2] * factor2 + c[2] * factor3 + d[2] * factor4;
    return out;
}`,
    },
    {
        module: 'vec3',
        fn: 'bezier',
        out: 3,
        args: [3, 3, 3, 3, 'n'],
        src: `function bezier(out, a, b, c, d, t) {
    const inverseFactor = 1 - t;
    const inverseFactorTimesTwo = inverseFactor * inverseFactor;
    const factorTimes2 = t * t;
    const factor1 = inverseFactorTimesTwo * inverseFactor;
    const factor2 = 3 * t * inverseFactorTimesTwo;
    const factor3 = 3 * factorTimes2 * inverseFactor;
    const factor4 = factorTimes2 * t;
    out[0] = a[0] * factor1 + b[0] * factor2 + c[0] * factor3 + d[0] * factor4;
    out[1] = a[1] * factor1 + b[1] * factor2 + c[1] * factor3 + d[1] * factor4;
    out[2] = a[2] * factor1 + b[2] * factor2 + c[2] * factor3 + d[2] * factor4;
    return out;
}`,
    },
    {
        module: 'vec3',
        fn: 'transformMat4',
        out: 3,
        args: [3, 16],
        src: `function transformMat4(out, a, m) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    w = w || 1.0;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
}`,
    },
    {
        module: 'vec3',
        fn: 'transformMat3',
        out: 3,
        args: [3, 9],
        src: 'function transformMat3(out, a, m) { const x = a[0]; const y = a[1]; const z = a[2]; out[0] = x * m[0] + y * m[3] + z * m[6]; out[1] = x * m[1] + y * m[4] + z * m[7]; out[2] = x * m[2] + y * m[5] + z * m[8]; return out; }',
    },
    {
        module: 'vec3',
        fn: 'transformQuat',
        out: 3,
        args: [3, 4],
        src: `function transformQuat(out, a, q) {
    // benchmarks: https://jsperf.com/quaternion-transform-vec3-implementations-fixed
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    const x = a[0];
    const y = a[1];
    const z = a[2];
    // var qvec = [qx, qy, qz];
    // var uv = vec3.cross([], qvec, a);
    let uvx = qy * z - qz * y;
    let uvy = qz * x - qx * z;
    let uvz = qx * y - qy * x;
    // var uuv = vec3.cross([], qvec, uv);
    let uuvx = qy * uvz - qz * uvy;
    let uuvy = qz * uvx - qx * uvz;
    let uuvz = qx * uvy - qy * uvx;
    // vec3.scale(uv, uv, 2 * w);
    const w2 = qw * 2;
    uvx *= w2;
    uvy *= w2;
    uvz *= w2;
    // vec3.scale(uuv, uuv, 2);
    uuvx *= 2;
    uuvy *= 2;
    uuvz *= 2;
    // return vec3.add(out, a, vec3.add(out, uv, uuv));
    out[0] = x + uvx + uuvx;
    out[1] = y + uvy + uuvy;
    out[2] = z + uvz + uuvz;
    return out;
}`,
    },
    {
        module: 'vec3',
        fn: 'rotateX',
        out: 3,
        args: [3, 3, 'n'],
        src: `function rotateX(out, a, b, rad) {
    const p = [];
    const r = [];
    //Translate point to the origin
    p[0] = a[0] - b[0];
    p[1] = a[1] - b[1];
    p[2] = a[2] - b[2];
    //perform rotation
    r[0] = p[0];
    r[1] = p[1] * Math.cos(rad) - p[2] * Math.sin(rad);
    r[2] = p[1] * Math.sin(rad) + p[2] * Math.cos(rad);
    //translate to correct position
    out[0] = r[0] + b[0];
    out[1] = r[1] + b[1];
    out[2] = r[2] + b[2];
    return out;
}`,
    },
    {
        module: 'vec3',
        fn: 'rotateY',
        out: 3,
        args: [3, 3, 'n'],
        src: `function rotateY(out, a, b, rad) {
    const p = [];
    const r = [];
    //Translate point to the origin
    p[0] = a[0] - b[0];
    p[1] = a[1] - b[1];
    p[2] = a[2] - b[2];
    //perform rotation
    r[0] = p[2] * Math.sin(rad) + p[0] * Math.cos(rad);
    r[1] = p[1];
    r[2] = p[2] * Math.cos(rad) - p[0] * Math.sin(rad);
    //translate to correct position
    out[0] = r[0] + b[0];
    out[1] = r[1] + b[1];
    out[2] = r[2] + b[2];
    return out;
}`,
    },
    {
        module: 'vec3',
        fn: 'rotateZ',
        out: 3,
        args: [3, 3, 'n'],
        src: `function rotateZ(out, a, b, rad) {
    const p = [];
    const r = [];
    //Translate point to the origin
    p[0] = a[0] - b[0];
    p[1] = a[1] - b[1];
    p[2] = a[2] - b[2];
    //perform rotation
    r[0] = p[0] * Math.cos(rad) - p[1] * Math.sin(rad);
    r[1] = p[0] * Math.sin(rad) + p[1] * Math.cos(rad);
    r[2] = p[2];
    //translate to correct position
    out[0] = r[0] + b[0];
    out[1] = r[1] + b[1];
    out[2] = r[2] + b[2];
    return out;
}`,
    },

    // ---- vec4 ----
    {
        module: 'vec4',
        fn: 'add',
        out: 4,
        args: [4, 4],
        src: 'function add(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; out[3] = a[3] + b[3]; return out; }',
    },
    {
        module: 'vec4',
        fn: 'subtract',
        out: 4,
        args: [4, 4],
        src: 'function subtract(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; out[3] = a[3] - b[3]; return out; }',
    },
    {
        module: 'vec4',
        fn: 'multiply',
        out: 4,
        args: [4, 4],
        src: 'function multiply(out, a, b) { out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2]; out[3] = a[3] * b[3]; return out; }',
    },
    {
        module: 'vec4',
        fn: 'scale',
        out: 4,
        args: [4, 'n'],
        src: 'function scale(out, a, b) { out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b; out[3] = a[3] * b; return out; }',
    },
    {
        module: 'vec4',
        fn: 'scaleAndAdd',
        out: 4,
        args: [4, 4, 'n'],
        src: 'function scaleAndAdd(out, a, b, scale) { out[0] = a[0] + b[0] * scale; out[1] = a[1] + b[1] * scale; out[2] = a[2] + b[2] * scale; out[3] = a[3] + b[3] * scale; return out; }',
    },
    {
        module: 'vec4',
        fn: 'distance',
        out: 0,
        args: [4, 4],
        src: 'function distance(a, b) { const x = b[0] - a[0]; const y = b[1] - a[1]; const z = b[2] - a[2]; const w = b[3] - a[3]; return Math.sqrt(x * x + y * y + z * z + w * w); }',
    },
    {
        module: 'vec4',
        fn: 'length',
        out: 0,
        args: [4],
        src: 'function length(a) { const x = a[0]; const y = a[1]; const z = a[2]; const w = a[3]; return Math.sqrt(x * x + y * y + z * z + w * w); }',
    },
    {
        module: 'vec4',
        fn: 'negate',
        out: 4,
        args: [4],
        src: 'function negate(out, a) { out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = -a[3]; return out; }',
    },
    {
        module: 'vec4',
        fn: 'normalize',
        out: 4,
        args: [4],
        src: `function normalize(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const w = a[3];
    let len = x * x + y * y + z * z + w * w;
    if (len > 0) {
        len = 1 / Math.sqrt(len);
    }
    out[0] = x * len;
    out[1] = y * len;
    out[2] = z * len;
    out[3] = w * len;
    return out;
}`,
    },
    {
        module: 'vec4',
        fn: 'dot',
        out: 0,
        args: [4, 4],
        src: 'function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; }',
    },
    {
        module: 'vec4',
        fn: 'cross',
        out: 4,
        args: [4, 4, 4],
        src: `function cross(out, u, v, w) {
    const A = v[0] * w[1] - v[1] * w[0];
    const B = v[0] * w[2] - v[2] * w[0];
    const C = v[0] * w[3] - v[3] * w[0];
    const D = v[1] * w[2] - v[2] * w[1];
    const E = v[1] * w[3] - v[3] * w[1];
    const F = v[2] * w[3] - v[3] * w[2];
    const G = u[0];
    const H = u[1];
    const I = u[2];
    const J = u[3];
    out[0] = H * F - I * E + J * D;
    out[1] = -(G * F) + I * C - J * B;
    out[2] = G * E - H * C + J * A;
    out[3] = -(G * D) + H * B - I * A;
    return out;
}`,
    },
    {
        module: 'vec4',
        fn: 'lerp',
        out: 4,
        args: [4, 4, 'n'],
        src: 'function lerp(out, a, b, t) { const ax = a[0]; const ay = a[1]; const az = a[2]; const aw = a[3]; out[0] = ax + t * (b[0] - ax); out[1] = ay + t * (b[1] - ay); out[2] = az + t * (b[2] - az); out[3] = aw + t * (b[3] - aw); return out; }',
    },
    {
        module: 'vec4',
        fn: 'transformMat4',
        out: 4,
        args: [4, 16],
        src: `function transformMat4(out, a, m) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const w = a[3];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return out;
}`,
    },
    {
        module: 'vec4',
        fn: 'transformQuat',
        out: 4,
        args: [4, 4],
        src: `function transformQuat(out, a, q) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    // calculate quat * vec
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    // calculate result * inverse quat
    out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    out[3] = a[3];
    return out;
}`,
    },

    // ---- quat ----
    {
        module: 'quat',
        fn: 'setAxisAngle',
        out: 4,
        args: [3, 'n'],
        src: `function setAxisAngle(out, axis, rad) {
    rad *= 0.5;
    const s = Math.sin(rad);
    out[0] = s * axis[0];
    out[1] = s * axis[1];
    out[2] = s * axis[2];
    out[3] = Math.cos(rad);
    return out;
}`,
    },
    {
        module: 'quat',
        fn: 'multiply',
        out: 4,
        args: [4, 4],
        src: `function multiply(out, a, b) {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    const bx = b[0];
    const by = b[1];
    const bz = b[2];
    const bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}`,
    },
    {
        module: 'quat',
        fn: 'rotateX',
        out: 4,
        args: [4, 'n'],
        src: `function rotateX(out, a, rad) {
    rad *= 0.5;
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    const bx = Math.sin(rad);
    const bw = Math.cos(rad);
    out[0] = ax * bw + aw * bx;
    out[1] = ay * bw + az * bx;
    out[2] = az * bw - ay * bx;
    out[3] = aw * bw - ax * bx;
    return out;
}`,
    },
    {
        module: 'quat',
        fn: 'rotateY',
        out: 4,
        args: [4, 'n'],
        src: `function rotateY(out, a, rad) {
    rad *= 0.5;
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    const by = Math.sin(rad);
    const bw = Math.cos(rad);
    out[0] = ax * bw - az * by;
    out[1] = ay * bw + aw * by;
    out[2] = az * bw + ax * by;
    out[3] = aw * bw - ay * by;
    return out;
}`,
    },
    {
        module: 'quat',
        fn: 'rotateZ',
        out: 4,
        args: [4, 'n'],
        src: `function rotateZ(out, a, rad) {
    rad *= 0.5;
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    const bz = Math.sin(rad);
    const bw = Math.cos(rad);
    out[0] = ax * bw + ay * bz;
    out[1] = ay * bw - ax * bz;
    out[2] = az * bw + aw * bz;
    out[3] = aw * bw - az * bz;
    return out;
}`,
    },
    {
        module: 'quat',
        fn: 'calculateW',
        out: 4,
        args: [4],
        src: `function calculateW(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = Math.sqrt(Math.abs(1.0 - x * x - y * y - z * z));
    return out;
}`,
    },
    {
        module: 'quat',
        fn: 'exp',
        out: 4,
        args: [4],
        src: `function exp(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const w = a[3];
    const r = Math.sqrt(x * x + y * y + z * z);
    const et = Math.exp(w);
    const s = r > 0 ? (et * Math.sin(r)) / r : 0;
    out[0] = x * s;
    out[1] = y * s;
    out[2] = z * s;
    out[3] = et * Math.cos(r);
    return out;
}`,
    },
    {
        module: 'quat',
        fn: 'ln',
        out: 4,
        args: [4],
        src: `function ln(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const w = a[3];
    const r = Math.sqrt(x * x + y * y + z * z);
    const t = r > 0 ? Math.atan2(r, w) / r : 0;
    out[0] = x * t;
    out[1] = y * t;
    out[2] = z * t;
    out[3] = 0.5 * Math.log(x * x + y * y + z * z + w * w);
    return out;
}`,
    },
    {
        module: 'quat',
        fn: 'invert',
        out: 4,
        args: [4],
        src: `function invert(out, a) {
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const a3 = a[3];
    const dot = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
    const invDot = dot ? 1.0 / dot : 0;
    // TODO: Would be faster to return [0,0,0,0] immediately if dot == 0
    out[0] = -a0 * invDot;
    out[1] = -a1 * invDot;
    out[2] = -a2 * invDot;
    out[3] = a3 * invDot;
    return out;
}`,
    },
    {
        module: 'quat',
        fn: 'conjugate',
        out: 4,
        args: [4],
        src: 'function conjugate(out, a) { out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = a[3]; return out; }',
    },
    {
        module: 'quat',
        fn: 'fromMat3',
        out: 4,
        args: [9],
        src: `function fromMat3(out, m) {
    // Algorithm in Ken Shoemake's article in 1987 SIGGRAPH course notes
    // article "Quaternion Calculus and Fast Animation".
    const fTrace = m[0] + m[4] + m[8];
    let fRoot;
    if (fTrace > 0.0) {
        // |w| > 1/2, may as well choose w > 1/2
        fRoot = Math.sqrt(fTrace + 1.0); // 2w
        out[3] = 0.5 * fRoot;
        fRoot = 0.5 / fRoot; // 1/(4w)
        out[0] = (m[5] - m[7]) * fRoot;
        out[1] = (m[6] - m[2]) * fRoot;
        out[2] = (m[1] - m[3]) * fRoot;
    }
    else {
        // |w| <= 1/2
        let i = 0;
        if (m[4] > m[0])
            i = 1;
        if (m[8] > m[i * 3 + i])
            i = 2;
        const j = (i + 1) % 3;
        const k = (i + 2) % 3;
        fRoot = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1.0);
        out[i] = 0.5 * fRoot;
        fRoot = 0.5 / fRoot;
        out[3] = (m[j * 3 + k] - m[k * 3 + j]) * fRoot;
        out[j] = (m[j * 3 + i] + m[i * 3 + j]) * fRoot;
        out[k] = (m[k * 3 + i] + m[i * 3 + k]) * fRoot;
    }
    return out;
}`,
    },

    // ---- mat2 ----
    {
        module: 'mat2',
        fn: 'transpose',
        out: 4,
        args: [4],
        src: `function transpose(out, a) {
    // If we are transposing ourselves we can skip a few steps but have to cache
    // some values
    if (out === a) {
        const a1 = a[1];
        out[1] = a[2];
        out[2] = a1;
    }
    else {
        out[0] = a[0];
        out[1] = a[2];
        out[2] = a[1];
        out[3] = a[3];
    }
    return out;
}`,
    },
    {
        module: 'mat2',
        fn: 'invert',
        out: 4,
        args: [4],
        src: `function invert(out, a) {
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const a3 = a[3];
    // Calculate the determinant
    let det = a0 * a3 - a2 * a1;
    if (!det) {
        return null;
    }
    det = 1.0 / det;
    out[0] = a3 * det;
    out[1] = -a1 * det;
    out[2] = -a2 * det;
    out[3] = a0 * det;
    return out;
}`,
    },
    {
        module: 'mat2',
        fn: 'adjoint',
        out: 4,
        args: [4],
        src: `function adjoint(out, a) {
    // Caching this value is necessary if out == a
    const a0 = a[0];
    out[0] = a[3];
    out[1] = -a[1];
    out[2] = -a[2];
    out[3] = a0;
    return out;
}`,
    },
    {
        module: 'mat2',
        fn: 'determinant',
        out: 0,
        args: [4],
        src: 'function determinant(a) { return a[0] * a[3] - a[2] * a[1]; }',
    },
    {
        module: 'mat2',
        fn: 'multiply',
        out: 4,
        args: [4, 4],
        src: `function multiply(out, a, b) {
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const a3 = a[3];
    const b0 = b[0];
    const b1 = b[1];
    const b2 = b[2];
    const b3 = b[3];
    out[0] = a0 * b0 + a2 * b1;
    out[1] = a1 * b0 + a3 * b1;
    out[2] = a0 * b2 + a2 * b3;
    out[3] = a1 * b2 + a3 * b3;
    return out;
}`,
    },
    {
        module: 'mat2',
        fn: 'rotate',
        out: 4,
        args: [4, 'n'],
        src: `function rotate(out, a, rad) {
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const a3 = a[3];
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    out[0] = a0 * c + a2 * s;
    out[1] = a1 * c + a3 * s;
    out[2] = a0 * -s + a2 * c;
    out[3] = a1 * -s + a3 * c;
    return out;
}`,
    },
    {
        module: 'mat2',
        fn: 'scale',
        out: 4,
        args: [4, 2],
        src: `function scale(out, a, v) {
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const a3 = a[3];
    const v0 = v[0];
    const v1 = v[1];
    out[0] = a0 * v0;
    out[1] = a1 * v0;
    out[2] = a2 * v1;
    out[3] = a3 * v1;
    return out;
}`,
    },
    {
        module: 'mat2',
        fn: 'fromRotation',
        out: 4,
        args: ['n'],
        src: 'function fromRotation(out, rad) { const s = Math.sin(rad); const c = Math.cos(rad); out[0] = c; out[1] = s; out[2] = -s; out[3] = c; return out; }',
    },
    {
        module: 'mat2',
        fn: 'frob',
        out: 0,
        args: [4],
        src: 'function frob(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]); }',
    },
    {
        module: 'mat2',
        fn: 'multiplyScalar',
        out: 4,
        args: [4, 'n'],
        src: 'function multiplyScalar(out, a, b) { out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b; out[3] = a[3] * b; return out; }',
    },

    // ---- mat3 ----
    {
        module: 'mat3',
        fn: 'fromMat4',
        out: 9,
        args: [16],
        src: 'function fromMat4(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[4]; out[4] = a[5]; out[5] = a[6]; out[6] = a[8]; out[7] = a[9]; out[8] = a[10]; return out; }',
    },
    {
        module: 'mat3',
        fn: 'transpose',
        out: 9,
        args: [9],
        src: `function transpose(out, a) {
    // If we are transposing ourselves we can skip a few steps but have to cache some values
    if (out === a) {
        const a01 = a[1];
        const a02 = a[2];
        const a12 = a[5];
        out[1] = a[3];
        out[2] = a[6];
        out[3] = a01;
        out[5] = a[7];
        out[6] = a02;
        out[7] = a12;
    }
    else {
        out[0] = a[0];
        out[1] = a[3];
        out[2] = a[6];
        out[3] = a[1];
        out[4] = a[4];
        out[5] = a[7];
        out[6] = a[2];
        out[7] = a[5];
        out[8] = a[8];
    }
    return out;
}`,
    },
    {
        module: 'mat3',
        fn: 'invert',
        out: 9,
        args: [9],
        src: `function invert(out, a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[3];
    const a11 = a[4];
    const a12 = a[5];
    const a20 = a[6];
    const a21 = a[7];
    const a22 = a[8];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    // Calculate the determinant
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (!det) {
        return null;
    }
    det = 1.0 / det;
    out[0] = b01 * det;
    out[1] = (-a22 * a01 + a02 * a21) * det;
    out[2] = (a12 * a01 - a02 * a11) * det;
    out[3] = b11 * det;
    out[4] = (a22 * a00 - a02 * a20) * det;
    out[5] = (-a12 * a00 + a02 * a10) * det;
    out[6] = b21 * det;
    out[7] = (-a21 * a00 + a01 * a20) * det;
    out[8] = (a11 * a00 - a01 * a10) * det;
    return out;
}`,
    },
    {
        module: 'mat3',
        fn: 'adjoint',
        out: 9,
        args: [9],
        src: `function adjoint(out, a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[3];
    const a11 = a[4];
    const a12 = a[5];
    const a20 = a[6];
    const a21 = a[7];
    const a22 = a[8];
    out[0] = a11 * a22 - a12 * a21;
    out[1] = a02 * a21 - a01 * a22;
    out[2] = a01 * a12 - a02 * a11;
    out[3] = a12 * a20 - a10 * a22;
    out[4] = a00 * a22 - a02 * a20;
    out[5] = a02 * a10 - a00 * a12;
    out[6] = a10 * a21 - a11 * a20;
    out[7] = a01 * a20 - a00 * a21;
    out[8] = a00 * a11 - a01 * a10;
    return out;
}`,
    },
    {
        module: 'mat3',
        fn: 'determinant',
        out: 0,
        args: [9],
        src: `function determinant(a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[3];
    const a11 = a[4];
    const a12 = a[5];
    const a20 = a[6];
    const a21 = a[7];
    const a22 = a[8];
    return a00 * (a22 * a11 - a12 * a21) + a01 * (-a22 * a10 + a12 * a20) + a02 * (a21 * a10 - a11 * a20);
}`,
    },
    {
        module: 'mat3',
        fn: 'multiply',
        out: 9,
        args: [9, 9],
        src: `function multiply(out, a, b) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[3];
    const a11 = a[4];
    const a12 = a[5];
    const a20 = a[6];
    const a21 = a[7];
    const a22 = a[8];
    const b00 = b[0];
    const b01 = b[1];
    const b02 = b[2];
    const b10 = b[3];
    const b11 = b[4];
    const b12 = b[5];
    const b20 = b[6];
    const b21 = b[7];
    const b22 = b[8];
    out[0] = b00 * a00 + b01 * a10 + b02 * a20;
    out[1] = b00 * a01 + b01 * a11 + b02 * a21;
    out[2] = b00 * a02 + b01 * a12 + b02 * a22;
    out[3] = b10 * a00 + b11 * a10 + b12 * a20;
    out[4] = b10 * a01 + b11 * a11 + b12 * a21;
    out[5] = b10 * a02 + b11 * a12 + b12 * a22;
    out[6] = b20 * a00 + b21 * a10 + b22 * a20;
    out[7] = b20 * a01 + b21 * a11 + b22 * a21;
    out[8] = b20 * a02 + b21 * a12 + b22 * a22;
    return out;
}`,
    },
    {
        module: 'mat3',
        fn: 'translate',
        out: 9,
        args: [9, 2],
        src: `function translate(out, a, v) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[3];
    const a11 = a[4];
    const a12 = a[5];
    const a20 = a[6];
    const a21 = a[7];
    const a22 = a[8];
    const x = v[0];
    const y = v[1];
    out[0] = a00;
    out[1] = a01;
    out[2] = a02;
    out[3] = a10;
    out[4] = a11;
    out[5] = a12;
    out[6] = x * a00 + y * a10 + a20;
    out[7] = x * a01 + y * a11 + a21;
    out[8] = x * a02 + y * a12 + a22;
    return out;
}`,
    },
    {
        module: 'mat3',
        fn: 'rotate',
        out: 9,
        args: [9, 'n'],
        src: `function rotate(out, a, rad) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[3];
    const a11 = a[4];
    const a12 = a[5];
    const a20 = a[6];
    const a21 = a[7];
    const a22 = a[8];
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    out[0] = c * a00 + s * a10;
    out[1] = c * a01 + s * a11;
    out[2] = c * a02 + s * a12;
    out[3] = c * a10 - s * a00;
    out[4] = c * a11 - s * a01;
    out[5] = c * a12 - s * a02;
    out[6] = a20;
    out[7] = a21;
    out[8] = a22;
    return out;
}`,
    },
    {
        module: 'mat3',
        fn: 'scale',
        out: 9,
        args: [9, 2],
        src: `function scale(out, a, v) {
    const x = v[0];
    const y = v[1];
    out[0] = x * a[0];
    out[1] = x * a[1];
    out[2] = x * a[2];
    out[3] = y * a[3];
    out[4] = y * a[4];
    out[5] = y * a[5];
    out[6] = a[6];
    out[7] = a[7];
    out[8] = a[8];
    return out;
}`,
    },
    {
        module: 'mat3',
        fn: 'fromMat2d',
        out: 9,
        args: [6],
        src: 'function fromMat2d(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = 0; out[3] = a[2]; out[4] = a[3]; out[5] = 0; out[6] = a[4]; out[7] = a[5]; out[8] = 1; return out; }',
    },
    {
        module: 'mat3',
        fn: 'fromQuat',
        out: 9,
        args: [4],
        src: `function fromQuat(out, q) {
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const yx = y * x2;
    const yy = y * y2;
    const zx = z * x2;
    const zy = z * y2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    out[0] = 1 - yy - zz;
    out[3] = yx - wz;
    out[6] = zx + wy;
    out[1] = yx + wz;
    out[4] = 1 - xx - zz;
    out[7] = zy - wx;
    out[2] = zx - wy;
    out[5] = zy + wx;
    out[8] = 1 - xx - yy;
    return out;
}`,
    },
    {
        module: 'mat3',
        fn: 'normalFromMat4',
        out: 9,
        args: [16],
        src: `function normalFromMat4(out, a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    // Calculate the determinant
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) {
        return null;
    }
    det = 1.0 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[2] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[3] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[4] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[5] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[6] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[7] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[8] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    return out;
}`,
    },
    {
        module: 'mat3',
        fn: 'projection',
        out: 9,
        args: ['n', 'n'],
        src: 'function projection(out, width, height) { out[0] = 2 / width; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = -2 / height; out[5] = 0; out[6] = -1; out[7] = 1; out[8] = 1; return out; }',
    },
    {
        module: 'mat3',
        fn: 'multiplyScalarAndAdd',
        out: 9,
        args: [9, 9, 'n'],
        src: 'function multiplyScalarAndAdd(out, a, b, scale) { out[0] = a[0] + b[0] * scale; out[1] = a[1] + b[1] * scale; out[2] = a[2] + b[2] * scale; out[3] = a[3] + b[3] * scale; out[4] = a[4] + b[4] * scale; out[5] = a[5] + b[5] * scale; out[6] = a[6] + b[6] * scale; out[7] = a[7] + b[7] * scale; out[8] = a[8] + b[8] * scale; return out; }',
    },

    // ---- mat4 ----
    {
        module: 'mat4',
        fn: 'transpose',
        out: 16,
        args: [16],
        src: `function transpose(out, a) {
    // If we are transposing ourselves we can skip a few steps but have to cache some values
    if (out === a) {
        const a01 = a[1];
        const a02 = a[2];
        const a03 = a[3];
        const a12 = a[6];
        const a13 = a[7];
        const a23 = a[11];
        out[1] = a[4];
        out[2] = a[8];
        out[3] = a[12];
        out[4] = a01;
        out[6] = a[9];
        out[7] = a[13];
        out[8] = a02;
        out[9] = a12;
        out[11] = a[14];
        out[12] = a03;
        out[13] = a13;
        out[14] = a23;
    }
    else {
        out[0] = a[0];
        out[1] = a[4];
        out[2] = a[8];
        out[3] = a[12];
        out[4] = a[1];
        out[5] = a[5];
        out[6] = a[9];
        out[7] = a[13];
        out[8] = a[2];
        out[9] = a[6];
        out[10] = a[10];
        out[11] = a[14];
        out[12] = a[3];
        out[13] = a[7];
        out[14] = a[11];
        out[15] = a[15];
    }
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'invert',
        out: 16,
        args: [16],
        src: `function invert(out, a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    // Calculate the determinant
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) {
        return null;
    }
    det = 1.0 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'invert3x3',
        out: 16,
        args: [16],
        src: `function invert3x3(out, a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    // calculate the determinant
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (!det) {
        return null;
    }
    det = 1.0 / det;
    out[0] = b01 * det;
    out[1] = (-a22 * a01 + a02 * a21) * det;
    out[2] = (a12 * a01 - a02 * a11) * det;
    out[3] = 0;
    out[4] = b11 * det;
    out[5] = (a22 * a00 - a02 * a20) * det;
    out[6] = (-a12 * a00 + a02 * a10) * det;
    out[7] = 0;
    out[8] = b21 * det;
    out[9] = (-a21 * a00 + a01 * a20) * det;
    out[10] = (a11 * a00 - a01 * a10) * det;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'adjoint',
        out: 16,
        args: [16],
        src: `function adjoint(out, a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    out[0] = a11 * b11 - a12 * b10 + a13 * b09;
    out[1] = a02 * b10 - a01 * b11 - a03 * b09;
    out[2] = a31 * b05 - a32 * b04 + a33 * b03;
    out[3] = a22 * b04 - a21 * b05 - a23 * b03;
    out[4] = a12 * b08 - a10 * b11 - a13 * b07;
    out[5] = a00 * b11 - a02 * b08 + a03 * b07;
    out[6] = a32 * b02 - a30 * b05 - a33 * b01;
    out[7] = a20 * b05 - a22 * b02 + a23 * b01;
    out[8] = a10 * b10 - a11 * b08 + a13 * b06;
    out[9] = a01 * b08 - a00 * b10 - a03 * b06;
    out[10] = a30 * b04 - a31 * b02 + a33 * b00;
    out[11] = a21 * b02 - a20 * b04 - a23 * b00;
    out[12] = a11 * b07 - a10 * b09 - a12 * b06;
    out[13] = a00 * b09 - a01 * b07 + a02 * b06;
    out[14] = a31 * b01 - a30 * b03 - a32 * b00;
    out[15] = a20 * b03 - a21 * b01 + a22 * b00;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'determinant',
        out: 0,
        args: [16],
        src: `function determinant(a) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    const b0 = a00 * a11 - a01 * a10;
    const b1 = a00 * a12 - a02 * a10;
    const b2 = a01 * a12 - a02 * a11;
    const b3 = a20 * a31 - a21 * a30;
    const b4 = a20 * a32 - a22 * a30;
    const b5 = a21 * a32 - a22 * a31;
    const b6 = a00 * b5 - a01 * b4 + a02 * b3;
    const b7 = a10 * b5 - a11 * b4 + a12 * b3;
    const b8 = a20 * b2 - a21 * b1 + a22 * b0;
    const b9 = a30 * b2 - a31 * b1 + a32 * b0;
    // Calculate the determinant
    return a13 * b6 - a03 * b7 + a33 * b8 - a23 * b9;
}`,
    },
    {
        module: 'mat4',
        fn: 'multiply',
        out: 16,
        args: [16, 16],
        src: `function multiply(out, a, b) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    // Cache only the current line of the second matrix
    let b0 = b[0];
    let b1 = b[1];
    let b2 = b[2];
    let b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[4];
    b1 = b[5];
    b2 = b[6];
    b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[8];
    b1 = b[9];
    b2 = b[10];
    b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[12];
    b1 = b[13];
    b2 = b[14];
    b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'multiply3x3',
        out: 16,
        args: [16, 16],
        src: `function multiply3x3(out, a, b) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    let b0 = b[0];
    let b1 = b[1];
    let b2 = b[2];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22;
    out[3] = 0;
    b0 = b[4];
    b1 = b[5];
    b2 = b[6];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22;
    out[7] = 0;
    b0 = b[8];
    b1 = b[9];
    b2 = b[10];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'multiply3x3RightTransposed',
        out: 16,
        args: [16, 16],
        src: `function multiply3x3RightTransposed(out, a, b) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    let bt0 = b[0];
    let bt1 = b[4];
    let bt2 = b[8];
    out[0] = bt0 * a00 + bt1 * a10 + bt2 * a20;
    out[1] = bt0 * a01 + bt1 * a11 + bt2 * a21;
    out[2] = bt0 * a02 + bt1 * a12 + bt2 * a22;
    out[3] = 0;
    bt0 = b[1];
    bt1 = b[5];
    bt2 = b[9];
    out[4] = bt0 * a00 + bt1 * a10 + bt2 * a20;
    out[5] = bt0 * a01 + bt1 * a11 + bt2 * a21;
    out[6] = bt0 * a02 + bt1 * a12 + bt2 * a22;
    out[7] = 0;
    bt0 = b[2];
    bt1 = b[6];
    bt2 = b[10];
    out[8] = bt0 * a00 + bt1 * a10 + bt2 * a20;
    out[9] = bt0 * a01 + bt1 * a11 + bt2 * a21;
    out[10] = bt0 * a02 + bt1 * a12 + bt2 * a22;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'multiply3x3Vec',
        out: 3,
        args: [16, 3],
        src: `function multiply3x3Vec(out, mat, vec) {
    const x = vec[0];
    const y = vec[1];
    const z = vec[2];
    out[0] = mat[0] * x + mat[4] * y + mat[8] * z;
    out[1] = mat[1] * x + mat[5] * y + mat[9] * z;
    out[2] = mat[2] * x + mat[6] * y + mat[10] * z;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'multiply3x3TransposedVec',
        out: 3,
        args: [16, 3],
        src: `function multiply3x3TransposedVec(out, mat, vec) {
    const x = vec[0];
    const y = vec[1];
    const z = vec[2];
    out[0] = mat[0] * x + mat[1] * y + mat[2] * z;
    out[1] = mat[4] * x + mat[5] * y + mat[6] * z;
    out[2] = mat[8] * x + mat[9] * y + mat[10] * z;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'translate',
        out: 16,
        args: [16, 3],
        src: `function translate(out, a, v) {
    const x = v[0];
    const y = v[1];
    const z = v[2];
    let a00;
    let a01;
    let a02;
    let a03;
    let a10;
    let a11;
    let a12;
    let a13;
    let a20;
    let a21;
    let a22;
    let a23;
    if (a === out) {
        out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
        out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
        out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
        out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
    }
    else {
        a00 = a[0];
        a01 = a[1];
        a02 = a[2];
        a03 = a[3];
        a10 = a[4];
        a11 = a[5];
        a12 = a[6];
        a13 = a[7];
        a20 = a[8];
        a21 = a[9];
        a22 = a[10];
        a23 = a[11];
        out[0] = a00;
        out[1] = a01;
        out[2] = a02;
        out[3] = a03;
        out[4] = a10;
        out[5] = a11;
        out[6] = a12;
        out[7] = a13;
        out[8] = a20;
        out[9] = a21;
        out[10] = a22;
        out[11] = a23;
        out[12] = a00 * x + a10 * y + a20 * z + a[12];
        out[13] = a01 * x + a11 * y + a21 * z + a[13];
        out[14] = a02 * x + a12 * y + a22 * z + a[14];
        out[15] = a03 * x + a13 * y + a23 * z + a[15];
    }
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'scale',
        out: 16,
        args: [16, 3],
        src: `function scale(out, a, v) {
    const x = v[0];
    const y = v[1];
    const z = v[2];
    out[0] = a[0] * x;
    out[1] = a[1] * x;
    out[2] = a[2] * x;
    out[3] = a[3] * x;
    out[4] = a[4] * y;
    out[5] = a[5] * y;
    out[6] = a[6] * y;
    out[7] = a[7] * y;
    out[8] = a[8] * z;
    out[9] = a[9] * z;
    out[10] = a[10] * z;
    out[11] = a[11] * z;
    out[12] = a[12];
    out[13] = a[13];
    out[14] = a[14];
    out[15] = a[15];
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'rotateX',
        out: 16,
        args: [16, 'n'],
        src: `function rotateX(out, a, rad) {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    if (a !== out) {
        // If the source and destination differ, copy the unchanged rows
        out[0] = a[0];
        out[1] = a[1];
        out[2] = a[2];
        out[3] = a[3];
        out[12] = a[12];
        out[13] = a[13];
        out[14] = a[14];
        out[15] = a[15];
    }
    // Perform axis-specific matrix multiplication
    out[4] = a10 * c + a20 * s;
    out[5] = a11 * c + a21 * s;
    out[6] = a12 * c + a22 * s;
    out[7] = a13 * c + a23 * s;
    out[8] = a20 * c - a10 * s;
    out[9] = a21 * c - a11 * s;
    out[10] = a22 * c - a12 * s;
    out[11] = a23 * c - a13 * s;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'rotateY',
        out: 16,
        args: [16, 'n'],
        src: `function rotateY(out, a, rad) {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    if (a !== out) {
        // If the source and destination differ, copy the unchanged rows
        out[4] = a[4];
        out[5] = a[5];
        out[6] = a[6];
        out[7] = a[7];
        out[12] = a[12];
        out[13] = a[13];
        out[14] = a[14];
        out[15] = a[15];
    }
    // Perform axis-specific matrix multiplication
    out[0] = a00 * c - a20 * s;
    out[1] = a01 * c - a21 * s;
    out[2] = a02 * c - a22 * s;
    out[3] = a03 * c - a23 * s;
    out[8] = a00 * s + a20 * c;
    out[9] = a01 * s + a21 * c;
    out[10] = a02 * s + a22 * c;
    out[11] = a03 * s + a23 * c;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'rotateZ',
        out: 16,
        args: [16, 'n'],
        src: `function rotateZ(out, a, rad) {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    if (a !== out) {
        // If the source and destination differ, copy the unchanged last row
        out[8] = a[8];
        out[9] = a[9];
        out[10] = a[10];
        out[11] = a[11];
        out[12] = a[12];
        out[13] = a[13];
        out[14] = a[14];
        out[15] = a[15];
    }
    // Perform axis-specific matrix multiplication
    out[0] = a00 * c + a10 * s;
    out[1] = a01 * c + a11 * s;
    out[2] = a02 * c + a12 * s;
    out[3] = a03 * c + a13 * s;
    out[4] = a10 * c - a00 * s;
    out[5] = a11 * c - a01 * s;
    out[6] = a12 * c - a02 * s;
    out[7] = a13 * c - a03 * s;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'fromXRotation',
        out: 16,
        args: ['n'],
        src: `function fromXRotation(out, rad) {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    // Perform axis-specific matrix multiplication
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = c;
    out[6] = s;
    out[7] = 0;
    out[8] = 0;
    out[9] = -s;
    out[10] = c;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'fromTranslation',
        out: 16,
        args: [3],
        src: `function fromTranslation(out, v) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = 1;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = 1;
    out[11] = 0;
    out[12] = v[0];
    out[13] = v[1];
    out[14] = v[2];
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'fromRotationTranslation',
        out: 16,
        args: [4, 3],
        src: `function fromRotationTranslation(out, q, v) {
    // Quaternion math
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    out[0] = 1 - (yy + zz);
    out[1] = xy + wz;
    out[2] = xz - wy;
    out[3] = 0;
    out[4] = xy - wz;
    out[5] = 1 - (xx + zz);
    out[6] = yz + wx;
    out[7] = 0;
    out[8] = xz + wy;
    out[9] = yz - wx;
    out[10] = 1 - (xx + yy);
    out[11] = 0;
    out[12] = v[0];
    out[13] = v[1];
    out[14] = v[2];
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'fromRotationTranslationScale',
        out: 16,
        args: [4, 3, 3],
        src: `function fromRotationTranslationScale(out, q, v, s) {
    // Quaternion math
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const sx = s[0];
    const sy = s[1];
    const sz = s[2];
    out[0] = (1 - (yy + zz)) * sx;
    out[1] = (xy + wz) * sx;
    out[2] = (xz - wy) * sx;
    out[3] = 0;
    out[4] = (xy - wz) * sy;
    out[5] = (1 - (xx + zz)) * sy;
    out[6] = (yz + wx) * sy;
    out[7] = 0;
    out[8] = (xz + wy) * sz;
    out[9] = (yz - wx) * sz;
    out[10] = (1 - (xx + yy)) * sz;
    out[11] = 0;
    out[12] = v[0];
    out[13] = v[1];
    out[14] = v[2];
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'fromQuat',
        out: 16,
        args: [4],
        src: `function fromQuat(out, q) {
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const yx = y * x2;
    const yy = y * y2;
    const zx = z * x2;
    const zy = z * y2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    out[0] = 1 - yy - zz;
    out[1] = yx + wz;
    out[2] = zx - wy;
    out[3] = 0;
    out[4] = yx - wz;
    out[5] = 1 - xx - zz;
    out[6] = zy + wx;
    out[7] = 0;
    out[8] = zx + wy;
    out[9] = zy - wx;
    out[10] = 1 - xx - yy;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'getScaling',
        out: 3,
        args: [16],
        src: `function getScaling(out, mat) {
    const m11 = mat[0];
    const m12 = mat[1];
    const m13 = mat[2];
    const m21 = mat[4];
    const m22 = mat[5];
    const m23 = mat[6];
    const m31 = mat[8];
    const m32 = mat[9];
    const m33 = mat[10];
    out[0] = Math.sqrt(m11 * m11 + m12 * m12 + m13 * m13);
    out[1] = Math.sqrt(m21 * m21 + m22 * m22 + m23 * m23);
    out[2] = Math.sqrt(m31 * m31 + m32 * m32 + m33 * m33);
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'getTranslation',
        out: 3,
        args: [16],
        src: 'function getTranslation(out, mat) { out[0] = mat[12]; out[1] = mat[13]; out[2] = mat[14]; return out; }',
    },
    {
        module: 'mat4',
        fn: 'frustumNO',
        out: 16,
        args: ['n', 'n', 'n', 'n', 'n', 'n'],
        src: `function frustumNO(out, left, right, bottom, top, near, far) {
    const rl = 1 / (right - left);
    const tb = 1 / (top - bottom);
    const nf = 1 / (near - far);
    out[0] = near * 2 * rl;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = near * 2 * tb;
    out[6] = 0;
    out[7] = 0;
    out[8] = (right + left) * rl;
    out[9] = (top + bottom) * tb;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[12] = 0;
    out[13] = 0;
    out[14] = far * near * 2 * nf;
    out[15] = 0;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'orthoNO',
        out: 16,
        args: ['n', 'n', 'n', 'n', 'n', 'n'],
        src: `function orthoNO(out, left, right, bottom, top, near, far) {
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    out[0] = -2 * lr;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = -2 * bt;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = 2 * nf;
    out[11] = 0;
    out[12] = (left + right) * lr;
    out[13] = (top + bottom) * bt;
    out[14] = (far + near) * nf;
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'perspectiveNO',
        out: 16,
        args: ['n', 'n', 'n', 'n'],
        src: `function perspectiveNO(out, fovy, aspect, near, far) {
    const f = 1.0 / Math.tan(fovy / 2);
    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[11] = -1;
    out[12] = 0;
    out[13] = 0;
    out[15] = 0;
    if (far != null && far !== Number.POSITIVE_INFINITY) {
        const nf = 1 / (near - far);
        out[10] = (far + near) * nf;
        out[14] = 2 * far * near * nf;
    }
    else {
        out[10] = -1;
        out[14] = -2 * near;
    }
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'targetTo',
        out: 16,
        args: [3, 3, 3],
        src: `function targetTo(out, eye, target, up) {
    const eyex = eye[0];
    const eyey = eye[1];
    const eyez = eye[2];
    const upx = up[0];
    const upy = up[1];
    const upz = up[2];
    let z0 = eyex - target[0];
    let z1 = eyey - target[1];
    let z2 = eyez - target[2];
    let len = z0 * z0 + z1 * z1 + z2 * z2;
    if (len > 0) {
        len = 1 / Math.sqrt(len);
        z0 *= len;
        z1 *= len;
        z2 *= len;
    }
    let x0 = upy * z2 - upz * z1;
    let x1 = upz * z0 - upx * z2;
    let x2 = upx * z1 - upy * z0;
    len = x0 * x0 + x1 * x1 + x2 * x2;
    if (len > 0) {
        len = 1 / Math.sqrt(len);
        x0 *= len;
        x1 *= len;
        x2 *= len;
    }
    out[0] = x0;
    out[1] = x1;
    out[2] = x2;
    out[3] = 0;
    out[4] = z1 * x2 - z2 * x1;
    out[5] = z2 * x0 - z0 * x2;
    out[6] = z0 * x1 - z1 * x0;
    out[7] = 0;
    out[8] = z0;
    out[9] = z1;
    out[10] = z2;
    out[11] = 0;
    out[12] = eyex;
    out[13] = eyey;
    out[14] = eyez;
    out[15] = 1;
    return out;
}`,
    },
    {
        module: 'mat4',
        fn: 'multiplyScalar',
        out: 16,
        args: [16, 'n'],
        src: 'function multiplyScalar(out, a, b) { out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b; out[3] = a[3] * b; out[4] = a[4] * b; out[5] = a[5] * b; out[6] = a[6] * b; out[7] = a[7] * b; out[8] = a[8] * b; out[9] = a[9] * b; out[10] = a[10] * b; out[11] = a[11] * b; out[12] = a[12] * b; out[13] = a[13] * b; out[14] = a[14] * b; out[15] = a[15] * b; return out; }',
    },

    // ---- box3 (arity 6: [minX, minY, minZ, maxX, maxY, maxZ]) ----
    {
        module: 'box3',
        fn: 'setFromVectors',
        out: 6,
        args: [3, 3],
        src: 'function setFromVectors(out, min, max) { out[0] = min[0]; out[1] = min[1]; out[2] = min[2]; out[3] = max[0]; out[4] = max[1]; out[5] = max[2]; return out; }',
    },
    {
        module: 'box3',
        fn: 'min',
        out: 3,
        args: [6],
        src: 'function min(out, box) { out[0] = box[0]; out[1] = box[1]; out[2] = box[2]; return out; }',
    },
    {
        module: 'box3',
        fn: 'max',
        out: 3,
        args: [6],
        src: 'function max(out, box) { out[0] = box[3]; out[1] = box[4]; out[2] = box[5]; return out; }',
    },
    {
        module: 'box3',
        fn: 'expandByPoint',
        out: 6,
        args: [6, 3],
        src: 'function expandByPoint(out, box, point) { out[0] = Math.min(box[0], point[0]); out[1] = Math.min(box[1], point[1]); out[2] = Math.min(box[2], point[2]); out[3] = Math.max(box[3], point[0]); out[4] = Math.max(box[4], point[1]); out[5] = Math.max(box[5], point[2]); return out; }',
    },
    {
        module: 'box3',
        fn: 'expandByExtents',
        out: 6,
        args: [6, 3],
        src: 'function expandByExtents(out, box, vector) { out[0] = box[0] - vector[0]; out[1] = box[1] - vector[1]; out[2] = box[2] - vector[2]; out[3] = box[3] + vector[0]; out[4] = box[4] + vector[1]; out[5] = box[5] + vector[2]; return out; }',
    },
    {
        module: 'box3',
        fn: 'expandByMargin',
        out: 6,
        args: [6, 'n'],
        src: 'function expandByMargin(out, box, margin) { out[0] = box[0] - margin; out[1] = box[1] - margin; out[2] = box[2] - margin; out[3] = box[3] + margin; out[4] = box[4] + margin; out[5] = box[5] + margin; return out; }',
    },
    {
        module: 'box3',
        fn: 'union',
        out: 6,
        args: [6, 6],
        src: 'function union(out, boxA, boxB) { out[0] = Math.min(boxA[0], boxB[0]); out[1] = Math.min(boxA[1], boxB[1]); out[2] = Math.min(boxA[2], boxB[2]); out[3] = Math.max(boxA[3], boxB[3]); out[4] = Math.max(boxA[4], boxB[4]); out[5] = Math.max(boxA[5], boxB[5]); return out; }',
    },
    {
        module: 'box3',
        fn: 'center',
        out: 3,
        args: [6],
        src: 'function center(out, box) { out[0] = (box[0] + box[3]) * 0.5; out[1] = (box[1] + box[4]) * 0.5; out[2] = (box[2] + box[5]) * 0.5; return out; }',
    },
    {
        module: 'box3',
        fn: 'extents',
        out: 3,
        args: [6],
        src: 'function extents(out, box) { out[0] = (box[3] - box[0]) * 0.5; out[1] = (box[4] - box[1]) * 0.5; out[2] = (box[5] - box[2]) * 0.5; return out; }',
    },
    {
        module: 'box3',
        fn: 'size',
        out: 3,
        args: [6],
        src: 'function size(out, box) { out[0] = box[3] - box[0]; out[1] = box[4] - box[1]; out[2] = box[5] - box[2]; return out; }',
    },
    {
        module: 'box3',
        fn: 'surfaceArea',
        out: 0,
        args: [6],
        src: 'function surfaceArea(box) { const width = box[3] - box[0]; const height = box[4] - box[1]; const depth = box[5] - box[2]; return 2 * (width * height + width * depth + height * depth); }',
    },
    {
        module: 'box3',
        fn: 'scale',
        out: 6,
        args: [6, 3],
        src: `function scale(out, box, scale) {
    const minX = box[0] * scale[0];
    const maxX = box[3] * scale[0];
    const minY = box[1] * scale[1];
    const maxY = box[4] * scale[1];
    const minZ = box[2] * scale[2];
    const maxZ = box[5] * scale[2];
    // handle negative scaling by ensuring min <= max for each axis
    out[0] = Math.min(minX, maxX);
    out[3] = Math.max(minX, maxX);
    out[1] = Math.min(minY, maxY);
    out[4] = Math.max(minY, maxY);
    out[2] = Math.min(minZ, maxZ);
    out[5] = Math.max(minZ, maxZ);
    return out;
}`,
    },
    {
        module: 'box3',
        fn: 'transformMat4',
        out: 6,
        args: [6, 16],
        src: `function transformMat4(out, box, mat) {
    const bMinX = box[0];
    const bMinY = box[1];
    const bMinZ = box[2];
    const bMaxX = box[3];
    const bMaxY = box[4];
    const bMaxZ = box[5];
    // empty input → empty output (preserve sentinel rather than producing
    // a bogus transformed box from negative extents)
    if (bMinX > bMaxX || bMinY > bMaxY || bMinZ > bMaxZ) {
        out[0] = Number.POSITIVE_INFINITY;
        out[1] = Number.POSITIVE_INFINITY;
        out[2] = Number.POSITIVE_INFINITY;
        out[3] = Number.NEGATIVE_INFINITY;
        out[4] = Number.NEGATIVE_INFINITY;
        out[5] = Number.NEGATIVE_INFINITY;
        return out;
    }
    const cx = (bMinX + bMaxX) * 0.5;
    const cy = (bMinY + bMaxY) * 0.5;
    const cz = (bMinZ + bMaxZ) * 0.5;
    const ex = (bMaxX - bMinX) * 0.5;
    const ey = (bMaxY - bMinY) * 0.5;
    const ez = (bMaxZ - bMinZ) * 0.5;
    const m0 = mat[0], m1 = mat[1], m2 = mat[2];
    const m4 = mat[4], m5 = mat[5], m6 = mat[6];
    const m8 = mat[8], m9 = mat[9], m10 = mat[10];
    const tcx = m0 * cx + m4 * cy + m8 * cz + mat[12];
    const tcy = m1 * cx + m5 * cy + m9 * cz + mat[13];
    const tcz = m2 * cx + m6 * cy + m10 * cz + mat[14];
    const tex = Math.abs(m0) * ex + Math.abs(m4) * ey + Math.abs(m8) * ez;
    const tey = Math.abs(m1) * ex + Math.abs(m5) * ey + Math.abs(m9) * ez;
    const tez = Math.abs(m2) * ex + Math.abs(m6) * ey + Math.abs(m10) * ez;
    out[0] = tcx - tex;
    out[1] = tcy - tey;
    out[2] = tcz - tez;
    out[3] = tcx + tex;
    out[4] = tcy + tey;
    out[5] = tcz + tez;
    return out;
}`,
    },
];
