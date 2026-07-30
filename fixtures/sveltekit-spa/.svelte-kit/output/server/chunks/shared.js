import { a as is_plain_object$1, c as is_valid_array_len, d as valid_array_indices, f as MAX_ARRAY_INDEX, i as get_type, l as stringify_key, n as DevalueError, o as is_primitive, r as enumerable_symbols, s as is_valid_array_index, t as uneval, u as stringify_string } from "./uneval.js";
import { json, text } from "@sveltejs/kit";
import { HttpError, SvelteKitError } from "@sveltejs/kit/internal";
import { with_request_store } from "@sveltejs/kit/internal/server";
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/utils/functions.js
function noop() {}
/**
* @template T
* @param {() => T} fn
*/
function once(fn) {
	let done = false;
	/** @type T */
	let result;
	return () => {
		if (done) return result;
		done = true;
		return result = fn();
	};
}
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/constants.js
/**
* A fake asset path used in `vite dev` and `vite preview`, so that we can
* serve local assets while verifying that requests are correctly prefixed
*/
var SVELTE_KIT_ASSETS = "/_svelte_kit_assets";
var ENDPOINT_METHODS = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
	"HEAD"
];
var MUTATIVE_METHODS = [
	"POST",
	"PUT",
	"PATCH",
	"DELETE"
];
var PAGE_METHODS = [
	"GET",
	"POST",
	"HEAD"
];
//#endregion
//#region ../../node_modules/.bun/devalue@5.8.1/node_modules/devalue/src/base64.js
/**	@type {(array_buffer: ArrayBuffer) => string} */
function encode_native(array_buffer) {
	return new Uint8Array(array_buffer).toBase64();
}
/**	@type {(base64: string) => ArrayBuffer} */
function decode_native(base64) {
	return Uint8Array.fromBase64(base64).buffer;
}
/** @type {(array_buffer: ArrayBuffer) => string} */
function encode_buffer(array_buffer) {
	return Buffer.from(array_buffer).toString("base64");
}
/**	@type {(base64: string) => ArrayBuffer} */
function decode_buffer(base64) {
	return Uint8Array.from(Buffer.from(base64, "base64")).buffer;
}
/** @type {(array_buffer: ArrayBuffer) => string} */
function encode_legacy(array_buffer) {
	const array = new Uint8Array(array_buffer);
	let binary = "";
	const chunk_size = 32768;
	for (let i = 0; i < array.length; i += chunk_size) {
		const chunk = array.subarray(i, i + chunk_size);
		binary += String.fromCharCode.apply(null, chunk);
	}
	return btoa(binary);
}
/**	@type {(base64: string) => ArrayBuffer} */
function decode_legacy(base64) {
	const binary_string = atob(base64);
	const len = binary_string.length;
	const array = new Uint8Array(len);
	for (let i = 0; i < len; i++) array[i] = binary_string.charCodeAt(i);
	return array.buffer;
}
var native = typeof Uint8Array.fromBase64 === "function";
var buffer = typeof process === "object" && process.versions?.node !== void 0;
var encode64 = native ? encode_native : buffer ? encode_buffer : encode_legacy;
var decode64 = native ? decode_native : buffer ? decode_buffer : decode_legacy;
//#endregion
//#region ../../node_modules/.bun/devalue@5.8.1/node_modules/devalue/src/parse.js
/**
* Revive a value serialized with `devalue.stringify`
* @param {string} serialized
* @param {Record<string, (value: any) => any>} [revivers]
*/
function parse(serialized, revivers) {
	return unflatten(JSON.parse(serialized), revivers);
}
/**
* Revive a value flattened with `devalue.stringify`
* @param {number | any[]} parsed
* @param {Record<string, (value: any) => any>} [revivers]
*/
function unflatten(parsed, revivers) {
	if (typeof parsed === "number") return hydrate(parsed, true);
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Invalid input");
	const values = parsed;
	const hydrated = Array(values.length);
	/**
	* A set of values currently being hydrated with custom revivers,
	* used to detect invalid cyclical dependencies
	* @type {Set<number> | null}
	*/
	let hydrating = null;
	/**
	* @param {number} index
	* @returns {any}
	*/
	function hydrate(index, standalone = false) {
		if (index === -1) return void 0;
		if (index === -3) return NaN;
		if (index === -4) return Infinity;
		if (index === -5) return -Infinity;
		if (index === -6) return -0;
		if (standalone || typeof index !== "number") throw new Error(`Invalid input`);
		if (index in hydrated) return hydrated[index];
		const value = values[index];
		if (!value || typeof value !== "object") hydrated[index] = value;
		else if (Array.isArray(value)) if (typeof value[0] === "string") {
			const type = value[0];
			const reviver = revivers && Object.hasOwn(revivers, type) ? revivers[type] : void 0;
			if (reviver) {
				let i = value[1];
				if (typeof i !== "number") i = values.push(value[1]) - 1;
				hydrating ??= /* @__PURE__ */ new Set();
				if (hydrating.has(i)) throw new Error("Invalid circular reference");
				hydrating.add(i);
				hydrated[index] = reviver(hydrate(i));
				hydrating.delete(i);
				return hydrated[index];
			}
			switch (type) {
				case "Date":
					hydrated[index] = new Date(value[1]);
					break;
				case "Set":
					const set = /* @__PURE__ */ new Set();
					hydrated[index] = set;
					for (let i = 1; i < value.length; i += 1) set.add(hydrate(value[i]));
					break;
				case "Map":
					const map = /* @__PURE__ */ new Map();
					hydrated[index] = map;
					for (let i = 1; i < value.length; i += 2) map.set(hydrate(value[i]), hydrate(value[i + 1]));
					break;
				case "RegExp":
					hydrated[index] = new RegExp(value[1], value[2]);
					break;
				case "Object": {
					const wrapped_index = value[1];
					if (typeof values[wrapped_index] === "object" && values[wrapped_index][0] !== "BigInt") throw new Error("Invalid input");
					hydrated[index] = Object(hydrate(wrapped_index));
					break;
				}
				case "BigInt":
					hydrated[index] = BigInt(value[1]);
					break;
				case "null":
					const obj = Object.create(null);
					hydrated[index] = obj;
					for (let i = 1; i < value.length; i += 2) {
						if (value[i] === "__proto__") throw new Error("Cannot parse an object with a `__proto__` property");
						obj[value[i]] = hydrate(value[i + 1]);
					}
					break;
				case "Int8Array":
				case "Uint8Array":
				case "Uint8ClampedArray":
				case "Int16Array":
				case "Uint16Array":
				case "Float16Array":
				case "Int32Array":
				case "Uint32Array":
				case "Float32Array":
				case "Float64Array":
				case "BigInt64Array":
				case "BigUint64Array":
				case "DataView": {
					if (values[value[1]][0] !== "ArrayBuffer") throw new Error("Invalid data");
					const TypedArrayConstructor = globalThis[type];
					const buffer = hydrate(value[1]);
					hydrated[index] = value[2] !== void 0 ? new TypedArrayConstructor(buffer, value[2], value[3]) : new TypedArrayConstructor(buffer);
					break;
				}
				case "ArrayBuffer": {
					const base64 = value[1];
					if (typeof base64 !== "string") throw new Error("Invalid ArrayBuffer encoding");
					const arraybuffer = decode64(base64);
					hydrated[index] = arraybuffer;
					break;
				}
				case "Temporal.Duration":
				case "Temporal.Instant":
				case "Temporal.PlainDate":
				case "Temporal.PlainTime":
				case "Temporal.PlainDateTime":
				case "Temporal.PlainMonthDay":
				case "Temporal.PlainYearMonth":
				case "Temporal.ZonedDateTime": {
					const temporalName = type.slice(9);
					hydrated[index] = Temporal[temporalName].from(value[1]);
					break;
				}
				case "URL": {
					const url = new URL(value[1]);
					hydrated[index] = url;
					break;
				}
				case "URLSearchParams": {
					const url = new URLSearchParams(value[1]);
					hydrated[index] = url;
					break;
				}
				default: throw new Error(`Unknown type ${type}`);
			}
		} else if (value[0] === -7) {
			const len = value[1];
			if (!is_valid_array_len(len)) throw new Error("Invalid input");
			/** @type {any[]} */
			const array = [];
			hydrated[index] = array;
			array[MAX_ARRAY_INDEX] = void 0;
			delete array[MAX_ARRAY_INDEX];
			for (let i = 2; i < value.length; i += 2) {
				const idx = value[i];
				if (!is_valid_array_index(idx) || idx >= len) throw new Error("Invalid input");
				array[idx] = hydrate(value[i + 1]);
			}
			array.length = len;
		} else {
			const array = new Array(value.length);
			hydrated[index] = array;
			for (let i = 0; i < value.length; i += 1) {
				const n = value[i];
				if (n === -2) continue;
				array[i] = hydrate(n);
			}
		}
		else {
			/** @type {Record<string, any>} */
			const object = {};
			hydrated[index] = object;
			for (const key of Object.keys(value)) {
				if (key === "__proto__") throw new Error("Cannot parse an object with a `__proto__` property");
				const n = value[key];
				object[key] = hydrate(n);
			}
		}
		return hydrated[index];
	}
	return hydrate(0);
}
//#endregion
//#region ../../node_modules/.bun/devalue@5.8.1/node_modules/devalue/src/stringify.js
/**
* Turn a value into a JSON string that can be parsed with `devalue.parse`
* @param {any} value
* @param {Record<string, (value: any) => any>} [reducers]
*/
function stringify$1(value, reducers) {
	const stringified = run(false, value, reducers);
	return typeof stringified === "string" ? stringified : `[${stringified.join(",")}]`;
}
/**
* @param {boolean} async
* @param {any} value
* @param {Record<string, (value: any) => any>} [reducers]
*/
function run(async, value, reducers) {
	/** @type {any[]} */
	const stringified = [];
	/** @type {Map<any, number>} */
	const indexes = /* @__PURE__ */ new Map();
	/** @type {Array<{ key: string, fn: (value: any) => any }>} */
	const custom = [];
	if (reducers) for (const key of Object.getOwnPropertyNames(reducers)) custom.push({
		key,
		fn: reducers[key]
	});
	/** @type {string[]} */
	const keys = [];
	let p = 0;
	/**
	* @param {any} thing
	* @param {number} [index]
	*/
	function flatten(thing, index) {
		if (thing === void 0) return -1;
		if (Number.isNaN(thing)) return -3;
		if (thing === Infinity) return -4;
		if (thing === -Infinity) return -5;
		if (thing === 0 && 1 / thing < 0) return -6;
		if (indexes.has(thing)) return indexes.get(thing);
		index ??= p++;
		indexes.set(thing, index);
		for (const { key, fn } of custom) {
			const value = fn(thing);
			if (value) {
				stringified[index] = `["${key}",${flatten(value)}]`;
				return index;
			}
		}
		if (typeof thing === "function") throw new DevalueError(`Cannot stringify a function`, keys, thing, value);
		else if (typeof thing === "symbol") throw new DevalueError(`Cannot stringify a Symbol primitive`, keys, thing, value);
		/** @type {string | Promise<any>} */
		let str = "";
		if (is_primitive(thing)) str = stringify_primitive(thing);
		else if (typeof thing.then === "function") {
			if (!async) throw new DevalueError(`Cannot stringify a Promise or thenable — use stringifyAsync instead`, keys, thing, value);
			str = Promise.resolve(thing).then((value) => {
				const i = flatten(value, index);
				if (i < 0) stringified[index] = i;
			});
		} else {
			const type = get_type(thing);
			switch (type) {
				case "Number":
				case "String":
				case "Boolean":
				case "BigInt":
					str = `["Object",${flatten(thing.valueOf())}]`;
					break;
				case "Date":
					str = `["Date","${!isNaN(thing.getDate()) ? thing.toISOString() : ""}"]`;
					break;
				case "URL":
					str = `["URL",${stringify_string(thing.toString())}]`;
					break;
				case "URLSearchParams":
					str = `["URLSearchParams",${stringify_string(thing.toString())}]`;
					break;
				case "RegExp":
					const { source, flags } = thing;
					str = flags ? `["RegExp",${stringify_string(source)},"${flags}"]` : `["RegExp",${stringify_string(source)}]`;
					break;
				case "Array": {
					let mostly_dense = false;
					str = "[";
					for (let i = 0; i < thing.length; i += 1) {
						if (i > 0) str += ",";
						if (Object.hasOwn(thing, i)) {
							keys.push(`[${i}]`);
							str += flatten(thing[i]);
							keys.pop();
						} else if (mostly_dense) str += -2;
						else {
							const populated_keys = valid_array_indices(thing);
							const population = populated_keys.length;
							const d = String(thing.length).length;
							if ((thing.length - population) * 3 > 4 + d + population * (d + 1)) {
								str = "[-7," + thing.length;
								for (let j = 0; j < populated_keys.length; j++) {
									const key = populated_keys[j];
									keys.push(`[${key}]`);
									str += "," + key + "," + flatten(thing[key]);
									keys.pop();
								}
								break;
							} else {
								mostly_dense = true;
								str += -2;
							}
						}
					}
					str += "]";
					break;
				}
				case "Set":
					str = "[\"Set\"";
					for (const value of thing) str += `,${flatten(value)}`;
					str += "]";
					break;
				case "Map":
					str = "[\"Map\"";
					for (const [key, value] of thing) {
						keys.push(`.get(${is_primitive(key) ? stringify_primitive(key) : "..."})`);
						str += `,${flatten(key)},${flatten(value)}`;
						keys.pop();
					}
					str += "]";
					break;
				case "Int8Array":
				case "Uint8Array":
				case "Uint8ClampedArray":
				case "Int16Array":
				case "Uint16Array":
				case "Float16Array":
				case "Int32Array":
				case "Uint32Array":
				case "Float32Array":
				case "Float64Array":
				case "BigInt64Array":
				case "BigUint64Array":
				case "DataView": {
					/** @type {import("./types.js").TypedArray} */
					const typedArray = thing;
					str = "[\"" + type + "\"," + flatten(typedArray.buffer);
					if (typedArray.byteLength !== typedArray.buffer.byteLength) str += `,${typedArray.byteOffset},${typedArray.length}`;
					str += "]";
					break;
				}
				case "ArrayBuffer":
					str = `["ArrayBuffer","${encode64(thing)}"]`;
					break;
				case "Temporal.Duration":
				case "Temporal.Instant":
				case "Temporal.PlainDate":
				case "Temporal.PlainTime":
				case "Temporal.PlainDateTime":
				case "Temporal.PlainMonthDay":
				case "Temporal.PlainYearMonth":
				case "Temporal.ZonedDateTime":
					str = `["${type}",${stringify_string(thing.toString())}]`;
					break;
				default:
					if (!is_plain_object$1(thing)) throw new DevalueError(`Cannot stringify arbitrary non-POJOs`, keys, thing, value);
					if (enumerable_symbols(thing).length > 0) throw new DevalueError(`Cannot stringify POJOs with symbolic keys`, keys, thing, value);
					if (Object.getPrototypeOf(thing) === null) {
						str = "[\"null\"";
						for (const key of Object.keys(thing)) {
							if (key === "__proto__") throw new DevalueError(`Cannot stringify objects with __proto__ keys`, keys, thing, value);
							keys.push(stringify_key(key));
							str += `,${stringify_string(key)},${flatten(thing[key])}`;
							keys.pop();
						}
						str += "]";
					} else {
						str = "{";
						let started = false;
						for (const key of Object.keys(thing)) {
							if (key === "__proto__") throw new DevalueError(`Cannot stringify objects with __proto__ keys`, keys, thing, value);
							if (started) str += ",";
							started = true;
							keys.push(stringify_key(key));
							str += `${stringify_string(key)}:${flatten(thing[key])}`;
							keys.pop();
						}
						str += "}";
					}
			}
		}
		stringified[index] = str;
		return index;
	}
	const index = flatten(value);
	if (index < 0) return `${index}`;
	return stringified;
}
/**
* @param {any} thing
* @returns {string}
*/
function stringify_primitive(thing) {
	const type = typeof thing;
	if (type === "string") return stringify_string(thing);
	if (thing === void 0) return (-1).toString();
	if (thing === 0 && 1 / thing < 0) return (-6).toString();
	if (type === "bigint") return `["BigInt","${thing}"]`;
	return String(thing);
}
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/runtime/utils.js
var text_encoder = new TextEncoder();
/**
* Like node's path.relative, but without using node
* @param {string} from
* @param {string} to
*/
function get_relative_path(from, to) {
	const from_parts = from.split(/[/\\]/);
	const to_parts = to.split(/[/\\]/);
	from_parts.pop();
	while (from_parts[0] === to_parts[0]) {
		from_parts.shift();
		to_parts.shift();
	}
	let i = from_parts.length;
	while (i--) from_parts[i] = "..";
	return from_parts.concat(to_parts).join("/");
}
/**
* @param {Uint8Array} bytes
* @returns {string}
*/
function base64_encode(bytes) {
	if (globalThis.Buffer) return globalThis.Buffer.from(bytes).toString("base64");
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}
/**
* @param {string} encoded
* @returns {Uint8Array}
*/
function base64_decode(encoded) {
	if (globalThis.Buffer) {
		const buffer = globalThis.Buffer.from(encoded, "base64");
		return new Uint8Array(buffer);
	}
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/runtime/form-utils.js
/** @import { BinaryFormMeta, InternalRemoteFormIssue } from 'types' */
/** @import { StandardSchemaV1 } from '@standard-schema/spec' */
var decoder = new TextDecoder();
/**
* Sets a value in a nested object using a path string, mutating the original object
* @param {Record<string, any>} object
* @param {string} path_string
* @param {any} value
*/
function set_nested_value(object, path_string, value) {
	if (path_string.startsWith("n:")) {
		path_string = path_string.slice(2);
		value = value === "" ? void 0 : parseFloat(value);
	} else if (path_string.startsWith("b:")) {
		path_string = path_string.slice(2);
		value = value === "on";
	}
	deep_set(object, split_path(path_string), value);
}
/** Pass this to set_nested_value to delete the last part of the given path */
var DELETE_KEY = {};
/**
* Convert `FormData` into a POJO
* @param {FormData} data
*/
function convert_formdata(data) {
	/** @type {Record<string, any>} */
	const result = {};
	for (let key of data.keys()) {
		const is_array = key.endsWith("[]");
		/** @type {any[]} */
		let values = data.getAll(key);
		if (is_array) key = key.slice(0, -2);
		values = values.filter((entry) => typeof entry === "string" || entry.name !== "" || entry.size > 0);
		if (values.length === 0 && !is_array) continue;
		if (key.startsWith("n:")) {
			key = key.slice(2);
			values = values.map((v) => v === "" ? void 0 : parseFloat(v));
		} else if (key.startsWith("b:")) {
			key = key.slice(2);
			values = values.map((v) => v === "on");
		}
		if (values.length > 1 && !is_array) throw new Error(`Form cannot contain duplicated keys — "${key}" has ${values.length} values`);
		set_nested_value(result, key, is_array ? values : values[0]);
	}
	return result;
}
var BINARY_FORM_CONTENT_TYPE = "application/x-sveltekit-formdata";
var BINARY_FORM_VERSION = 0;
var HEADER_BYTES = 7;
/**
* @param {Request} request
* @returns {Promise<{ data: Record<string, any>; meta: BinaryFormMeta; form_data: FormData | null }>}
*/
async function deserialize_binary_form(request) {
	if (request.headers.get("content-type") !== "application/x-sveltekit-formdata") {
		const form_data = await request.formData();
		return {
			data: convert_formdata(form_data),
			meta: {},
			form_data
		};
	}
	if (!request.body) throw deserialize_error("no body");
	const reader = request.body.getReader();
	/** @type {Array<Promise<Uint8Array<ArrayBuffer> | undefined>>} */
	const chunks = [];
	/**
	* @param {number} index
	* @returns {Promise<Uint8Array<ArrayBuffer> | undefined>}
	*/
	function get_chunk(index) {
		if (index in chunks) return chunks[index];
		let i = chunks.length;
		while (i <= index) {
			chunks[i] = reader.read().then((chunk) => chunk.value);
			i++;
		}
		return chunks[index];
	}
	/**
	* @param {number} offset
	* @param {number} length
	* @returns {Promise<Uint8Array | null>}
	*/
	async function get_buffer(offset, length) {
		/** @type {Uint8Array} */
		let start_chunk;
		let chunk_start = 0;
		/** @type {number} */
		let chunk_index;
		for (chunk_index = 0;; chunk_index++) {
			const chunk = await get_chunk(chunk_index);
			if (!chunk) return null;
			const chunk_end = chunk_start + chunk.byteLength;
			if (offset >= chunk_start && offset < chunk_end) {
				start_chunk = chunk;
				break;
			}
			chunk_start = chunk_end;
		}
		if (offset + length <= chunk_start + start_chunk.byteLength) return start_chunk.subarray(offset - chunk_start, offset + length - chunk_start);
		const chunks = [start_chunk.subarray(offset - chunk_start)];
		let cursor = start_chunk.byteLength - offset + chunk_start;
		while (cursor < length) {
			chunk_index++;
			let chunk = await get_chunk(chunk_index);
			if (!chunk) return null;
			if (chunk.byteLength > length - cursor) chunk = chunk.subarray(0, length - cursor);
			chunks.push(chunk);
			cursor += chunk.byteLength;
		}
		const buffer = new Uint8Array(length);
		cursor = 0;
		for (const chunk of chunks) {
			buffer.set(chunk, cursor);
			cursor += chunk.byteLength;
		}
		return buffer;
	}
	const header = await get_buffer(0, HEADER_BYTES);
	if (!header) throw deserialize_error("too short");
	if (header[0] !== BINARY_FORM_VERSION) throw deserialize_error(`got version ${header[0]}, expected version ${BINARY_FORM_VERSION}`);
	const header_view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	const data_length = header_view.getUint32(1, true);
	const file_offsets_length = header_view.getUint16(5, true);
	const data_buffer = await get_buffer(HEADER_BYTES, data_length);
	if (!data_buffer) throw deserialize_error("data too short");
	/** @type {Array<number | undefined>} */
	let file_offsets;
	/** @type {number} */
	let files_start_offset;
	if (file_offsets_length > 0) {
		const file_offsets_buffer = await get_buffer(HEADER_BYTES + data_length, file_offsets_length);
		if (!file_offsets_buffer) throw deserialize_error("file offset table too short");
		const parsed_offsets = JSON.parse(decoder.decode(file_offsets_buffer));
		if (!Array.isArray(parsed_offsets) || parsed_offsets.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 0)) throw deserialize_error("invalid file offset table");
		file_offsets = parsed_offsets;
		files_start_offset = HEADER_BYTES + data_length + file_offsets_length;
	}
	/** @type {Array<{ offset: number, size: number }>} */
	const file_spans = [];
	const [data, meta] = parse(decoder.decode(data_buffer), { File: ([name, type, size, last_modified, index]) => {
		if (typeof name !== "string" || typeof type !== "string" || typeof size !== "number" || typeof last_modified !== "number" || typeof index !== "number") throw deserialize_error("invalid file metadata");
		let offset = file_offsets[index];
		if (offset === void 0) throw deserialize_error("duplicate file offset table index");
		file_offsets[index] = void 0;
		offset += files_start_offset;
		file_spans.push({
			offset,
			size
		});
		return new Proxy(new LazyFile(name, type, size, last_modified, get_chunk, offset), { getPrototypeOf() {
			return File.prototype;
		} });
	} });
	file_spans.sort((a, b) => a.offset - b.offset || a.size - b.size);
	for (let i = 1; i < file_spans.length; i++) {
		const previous = file_spans[i - 1];
		const current = file_spans[i];
		const previous_end = previous.offset + previous.size;
		if (previous_end < current.offset) throw deserialize_error("gaps in file data");
		if (previous_end > current.offset) throw deserialize_error("overlapping file data");
	}
	(async () => {
		let has_more = true;
		while (has_more) has_more = !!await get_chunk(chunks.length);
	})().catch(noop);
	return {
		data,
		meta,
		form_data: null
	};
}
/**
* @param {string} message
*/
function deserialize_error(message) {
	return new SvelteKitError(400, "Bad Request", `Could not deserialize binary form: ${message}`);
}
/** @implements {File} */
var LazyFile = class LazyFile {
	/** @type {(index: number) => Promise<Uint8Array<ArrayBuffer> | undefined>} */
	#get_chunk;
	/** @type {number} */
	#offset;
	/**
	* @param {string} name
	* @param {string} type
	* @param {number} size
	* @param {number} last_modified
	* @param {(index: number) => Promise<Uint8Array<ArrayBuffer> | undefined>} get_chunk
	* @param {number} offset
	*/
	constructor(name, type, size, last_modified, get_chunk, offset) {
		this.name = name;
		this.type = type;
		this.size = size;
		this.lastModified = last_modified;
		this.webkitRelativePath = "";
		this.#get_chunk = get_chunk;
		this.#offset = offset;
		this.arrayBuffer = this.arrayBuffer.bind(this);
		this.bytes = this.bytes.bind(this);
		this.slice = this.slice.bind(this);
		this.stream = this.stream.bind(this);
		this.text = this.text.bind(this);
	}
	/** @type {ArrayBuffer | undefined} */
	#buffer;
	async arrayBuffer() {
		this.#buffer ??= await new Response(this.stream()).arrayBuffer();
		return this.#buffer;
	}
	async bytes() {
		return new Uint8Array(await this.arrayBuffer());
	}
	/**
	* @param {number=} start
	* @param {number=} end
	* @param {string=} contentType
	*/
	slice(start = 0, end = this.size, contentType = this.type) {
		if (start < 0) start = Math.max(this.size + start, 0);
		else start = Math.min(start, this.size);
		if (end < 0) end = Math.max(this.size + end, 0);
		else end = Math.min(end, this.size);
		const size = Math.max(end - start, 0);
		return new LazyFile(this.name, contentType, size, this.lastModified, this.#get_chunk, this.#offset + start);
	}
	stream() {
		let cursor = 0;
		let chunk_index = 0;
		return new ReadableStream({
			start: async (controller) => {
				let chunk_start = 0;
				/** @type {Uint8Array} */
				let start_chunk;
				for (chunk_index = 0;; chunk_index++) {
					const chunk = await this.#get_chunk(chunk_index);
					if (!chunk) return null;
					const chunk_end = chunk_start + chunk.byteLength;
					if (this.#offset >= chunk_start && this.#offset < chunk_end) {
						start_chunk = chunk;
						break;
					}
					chunk_start = chunk_end;
				}
				if (this.#offset + this.size <= chunk_start + start_chunk.byteLength) {
					controller.enqueue(start_chunk.subarray(this.#offset - chunk_start, this.#offset + this.size - chunk_start));
					controller.close();
				} else {
					controller.enqueue(start_chunk.subarray(this.#offset - chunk_start));
					cursor = start_chunk.byteLength - this.#offset + chunk_start;
				}
			},
			pull: async (controller) => {
				chunk_index++;
				let chunk = await this.#get_chunk(chunk_index);
				if (!chunk) {
					controller.error("incomplete file data");
					controller.close();
					return;
				}
				if (chunk.byteLength > this.size - cursor) chunk = chunk.subarray(0, this.size - cursor);
				controller.enqueue(chunk);
				cursor += chunk.byteLength;
				if (cursor >= this.size) controller.close();
			}
		});
	}
	async text() {
		return decoder.decode(await this.arrayBuffer());
	}
};
var path_regex = /^[a-zA-Z_$]\w*(\.[a-zA-Z_$]\w*|\[\d+\])*$/;
/**
* @param {string} path
*/
function split_path(path) {
	if (!path_regex.test(path)) throw new Error(`Invalid path ${path}`);
	return path.split(/\.|\[|\]/).filter(Boolean);
}
/**
* Check if a property key is dangerous and could lead to prototype pollution
* @param {string} key
*/
function check_prototype_pollution(key) {
	if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(`Invalid key "${key}"`);
}
/**
* Sets a value in a nested object using an array of keys, mutating the original object.
* @param {Record<string, any>} object
* @param {string[]} keys
* @param {any} value
*/
function deep_set(object, keys, value) {
	let current = object;
	for (let i = 0; i < keys.length - 1; i += 1) {
		const key = keys[i];
		check_prototype_pollution(key);
		const is_array = /^\d+$/.test(keys[i + 1]);
		const inner = Object.hasOwn(current, key) ? current[key] : void 0;
		const exists = inner != null;
		if (exists && is_array !== Array.isArray(inner)) throw new Error(`Invalid array key ${keys[i + 1]}`);
		if (!exists) {
			if (value === DELETE_KEY) return;
			current[key] = is_array ? [] : {};
		}
		current = current[key];
	}
	const final_key = keys[keys.length - 1];
	check_prototype_pollution(final_key);
	if (value === DELETE_KEY) delete current[final_key];
	else current[final_key] = value;
}
/**
* @param {StandardSchemaV1.Issue} issue
* @param {boolean} server Whether this issue came from server validation
*/
function normalize_issue(issue, server = false) {
	/** @type {InternalRemoteFormIssue} */
	const normalized = {
		name: "",
		path: [],
		message: issue.message,
		server
	};
	if (issue.path !== void 0) {
		let name = "";
		for (const segment of issue.path) {
			const key = typeof segment === "object" ? segment.key : segment;
			normalized.path.push(key);
			if (typeof key === "number") name += `[${key}]`;
			else if (typeof key === "string") name += name === "" ? key : "." + key;
		}
		normalized.name = name;
	}
	return normalized;
}
/**
* @param {InternalRemoteFormIssue[]} issues
*/
function flatten_issues(issues) {
	/** @type {Record<string, InternalRemoteFormIssue[]>} */
	const result = {};
	for (const issue of issues) {
		(result.$ ??= []).push(issue);
		let name = "";
		if (issue.path !== void 0) for (const key of issue.path) {
			if (typeof key === "number") name += `[${key}]`;
			else if (typeof key === "string") name += name === "" ? key : "." + key;
			(result[name] ??= []).push(issue);
		}
	}
	return result;
}
/**
* Gets a nested value from an object using a path array
* @param {Record<string, any>} object
* @param {(string | number)[]} path
* @returns {any}
*/
function deep_get(object, path) {
	let current = object;
	for (const key of path) {
		if (current == null || typeof current !== "object") return current;
		current = current[key];
	}
	return current;
}
/**
*
* @param {string} field_type
* @param {boolean} is_array
* @param {unknown} input_value
*/
function get_type_prefix(field_type, is_array, input_value) {
	if (field_type === "number" || field_type === "range") return "n:";
	if (field_type === "checkbox" && !is_array) return "b:";
	if (field_type === "hidden" || field_type === "submit") {
		const input_type = typeof input_value;
		if (input_type === "number") return "n:";
		if (input_type === "boolean") return "b:";
	}
	return "";
}
/**
* A deep-clone implementation specifically for form data, where
* we don't need to worry about cycles and whatnot
* @param {any} value
* @returns {any}
*/
function deep_clone(value) {
	if (value !== null && typeof value === "object") {
		if (value instanceof Date) return new Date(value.getTime());
		if (value instanceof File) return value;
		if (Array.isArray(value)) return value.map(deep_clone);
		/** @type {Record<string, any>} */
		const clone = {};
		for (const key of Object.keys(value)) clone[key] = deep_clone(value[key]);
		return clone;
	}
	return value;
}
/**
* Creates a proxy-based field accessor for form data
* @param {any} target - Function or empty POJO
* @param {() => Record<string, any>} get - Function to get current input data
* @param {(path: (string | number)[], value: any) => void} set - Function to set input data
* @param {(path?: (string | number)[], all?: boolean) => Record<string, InternalRemoteFormIssue[]>} get_issues - Function to get current issues
* @param {() => Record<string, boolean>} get_touched - Function to get touched fields
* @param {() => Record<string, boolean>} get_dirty - Function to get dirty fields
* @param {(string | number)[]} path - Current access path
* @returns {any} Proxy object with name(), value(), and issues() methods
*/
function create_field_proxy(target, get, set, get_issues, get_touched, get_dirty, path) {
	const get_value = () => {
		return deep_clone(deep_get(get(), path));
	};
	return new Proxy(target, { get(target, prop) {
		if (typeof prop === "symbol") return target[prop];
		if (/^\d+$/.test(prop)) return create_field_proxy({}, get, set, get_issues, get_touched, get_dirty, [...path, parseInt(prop, 10)]);
		const key = build_path_string(path);
		const next = [...path, prop];
		if (prop === "set") {
			const set_func = function(newValue) {
				set(path, newValue);
				return newValue;
			};
			return create_field_proxy(set_func, get, set, get_issues, get_touched, get_dirty, next);
		}
		if (prop === "value") return create_field_proxy(get_value, get, set, get_issues, get_touched, get_dirty, next);
		if (prop === "issues" || prop === "allIssues") {
			const issues_func = () => {
				const all_issues = get_issues(path, prop === "allIssues")[key === "" ? "$" : key];
				if (prop === "allIssues") return all_issues?.map((issue) => ({
					path: issue.path,
					message: issue.message
				}));
				const issues = all_issues?.filter((issue) => issue.name === key)?.map((issue) => ({
					path: issue.path,
					message: issue.message
				}));
				return issues?.length ? issues : void 0;
			};
			return create_field_proxy(issues_func, get, set, get_issues, get_touched, get_dirty, next);
		}
		if (prop === "touched" || prop === "dirty") {
			const fn = () => {
				const object = prop === "dirty" ? get_dirty() : get_touched();
				if (key === "") return Object.keys(object).length > 0;
				if (Object.hasOwn(object, key)) return true;
				for (const candidate in object) {
					if (!Object.hasOwn(object, candidate)) continue;
					if (!candidate.startsWith(key)) continue;
					const next = candidate[key.length];
					if (next === "." || next === "[") return true;
				}
				return false;
			};
			return create_field_proxy(fn, get, set, get_issues, get_touched, get_dirty, next);
		}
		if (prop === "as") {
			/**
			* @param {string} type
			* @param {unknown} [input_value]
			*/
			const as_func = (type, input_value) => {
				const is_array = type === "file multiple" || type === "select multiple" || type === "checkbox" && typeof input_value === "string";
				/** @type {Record<string, any>} */
				const base_props = {
					name: get_type_prefix(type, is_array, input_value) + key + (is_array ? "[]" : ""),
					get "aria-invalid"() {
						const issues = get_issues();
						return key in issues ? "true" : void 0;
					}
				};
				if (type !== "text" && type !== "select" && type !== "select multiple") base_props.type = type === "file multiple" ? "file" : type;
				if (type === "submit" || type === "hidden") return Object.defineProperties(base_props, { value: {
					value: typeof input_value === "boolean" ? input_value ? "on" : "off" : input_value,
					enumerable: true
				} });
				if (type === "select" || type === "select multiple") return Object.defineProperties(base_props, {
					multiple: {
						value: is_array,
						enumerable: true
					},
					value: {
						enumerable: true,
						get() {
							return get_value() ?? input_value;
						}
					}
				});
				if (type === "checkbox" || type === "radio") {
					if (type === "checkbox" && !is_array) return Object.defineProperties(base_props, {
						defaultChecked: {
							enumerable: true,
							get() {
								return input_value;
							}
						},
						checked: {
							enumerable: true,
							get() {
								return get_value() ?? input_value;
							}
						}
					});
					return Object.defineProperties(base_props, {
						value: {
							value: input_value ?? "on",
							enumerable: true
						},
						checked: {
							enumerable: true,
							get() {
								const value = get_value();
								if (type === "radio") return value === input_value;
								return (value ?? []).includes(input_value);
							}
						}
					});
				}
				if (type === "file" || type === "file multiple") return Object.defineProperties(base_props, {
					multiple: {
						value: is_array,
						enumerable: true
					},
					files: {
						enumerable: true,
						get() {
							const value = get_value();
							if (value instanceof File) {
								if (typeof DataTransfer !== "undefined") {
									const fileList = new DataTransfer();
									fileList.items.add(value);
									return fileList.files;
								}
								return {
									0: value,
									length: 1
								};
							}
							if (Array.isArray(value) && value.every((f) => f instanceof File)) {
								if (typeof DataTransfer !== "undefined") {
									const fileList = new DataTransfer();
									value.forEach((file) => fileList.items.add(file));
									return fileList.files;
								}
								/** @type {any} */
								const fileListLike = { length: value.length };
								value.forEach((file, index) => {
									fileListLike[index] = file;
								});
								return fileListLike;
							}
							return null;
						}
					}
				});
				return Object.defineProperties(base_props, {
					defaultValue: {
						enumerable: true,
						get() {
							return input_value;
						}
					},
					value: {
						enumerable: true,
						get() {
							const value = get_value() ?? input_value;
							return value != null ? String(value) : "";
						}
					}
				});
			};
			return create_field_proxy(as_func, get, set, get_issues, get_touched, get_dirty, next);
		}
		return create_field_proxy({}, get, set, get_issues, get_touched, get_dirty, next);
	} });
}
/**
* Builds a path string from an array of path segments
* @param {(string | number)[]} path
* @returns {string}
*/
function build_path_string(path) {
	let result = "";
	for (const segment of path) if (typeof segment === "number") result += `[${segment}]`;
	else result += result === "" ? segment : "." + segment;
	return result;
}
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/utils/http.js
/**
* Given an Accept header and a list of possible content types, pick
* the most suitable one to respond with
* @param {string} accept
* @param {string[]} types
*/
function negotiate(accept, types) {
	/** @type {Array<{ type: string, subtype: string, q: number, i: number }>} */
	const parts = [];
	accept.split(",").forEach((str, i) => {
		const match = /([^/ \t]+)\/([^; \t]+)[ \t]*(?:;[ \t]*q=([0-9.]+))?/.exec(str);
		if (match) {
			const [, type, subtype, q = "1"] = match;
			parts.push({
				type,
				subtype,
				q: +q,
				i
			});
		}
	});
	parts.sort((a, b) => {
		if (a.q !== b.q) return b.q - a.q;
		if (a.subtype === "*" !== (b.subtype === "*")) return a.subtype === "*" ? 1 : -1;
		if (a.type === "*" !== (b.type === "*")) return a.type === "*" ? 1 : -1;
		return a.i - b.i;
	});
	let accepted;
	let min_priority = Infinity;
	for (const mimetype of types) {
		const [type, subtype] = mimetype.split("/");
		const priority = parts.findIndex((part) => (part.type === type || part.type === "*") && (part.subtype === subtype || part.subtype === "*"));
		if (priority !== -1 && priority < min_priority) {
			accepted = mimetype;
			min_priority = priority;
		}
	}
	return accepted;
}
/**
* Returns `true` if the request contains a `content-type` header with the given type
* @param {Request} request
* @param  {...string} types
*/
function is_content_type(request, ...types) {
	const type = request.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
	return types.includes(type.toLowerCase());
}
/**
* @param {Request} request
*/
function is_form_content_type(request) {
	return is_content_type(request, "application/x-www-form-urlencoded", "multipart/form-data", "text/plain", BINARY_FORM_CONTENT_TYPE);
}
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/utils/error.js
/**
* @param {unknown} err
* @return {Error}
*/
function coalesce_to_error(err) {
	return err instanceof Error || err && err.name && err.message ? err : new Error(JSON.stringify(err));
}
/**
* This is an identity function that exists to make TypeScript less
* paranoid about people throwing things that aren't errors, which
* frankly is not something we should care about
* @param {unknown} error
*/
function normalize_error(error) {
	return error;
}
/**
* @param {any} transformed
* @param {any} [error]
*/
function get_status(transformed, error) {
	const err = error ?? transformed;
	const status = err instanceof HttpError || err instanceof SvelteKitError ? err.status : 500;
	if (error == null || typeof transformed?.status !== "number") return status;
	else return transformed.status;
}
/**
* @param {unknown} error
*/
function get_message(error) {
	return error instanceof SvelteKitError ? error.text : "Internal Error";
}
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/utils/escape.js
/**
* When inside a double-quoted attribute value, only `&` and `"` hold special meaning.
* @see https://html.spec.whatwg.org/multipage/parsing.html#attribute-value-(double-quoted)-state
* @type {Record<string, string>}
*/
var escape_html_attr_dict = {
	"&": "&amp;",
	"\"": "&quot;"
};
/**
* @type {Record<string, string>}
*/
var escape_html_dict = {
	"&": "&amp;",
	"<": "&lt;"
};
var escape_html_attr_regex = new RegExp(`[${Object.keys(escape_html_attr_dict).join("")}]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|[\\ud800-\\udbff][\\udc00-\\udfff]|[\\udc00-\\udfff]`, "g");
var escape_html_regex = new RegExp(`[${Object.keys(escape_html_dict).join("")}]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|[\\ud800-\\udbff][\\udc00-\\udfff]|[\\udc00-\\udfff]`, "g");
/**
* Escapes unpaired surrogates (which are allowed in js strings but invalid in HTML) and
* escapes characters that are special.
*
* @param {string} str
* @param {boolean} [is_attr]
* @returns {string} escaped string
* @example const html = `<tag data-value="${escape_html('value', true)}">...</tag>`;
*/
function escape_html(str, is_attr) {
	const dict = is_attr ? escape_html_attr_dict : escape_html_dict;
	return str.replace(is_attr ? escape_html_attr_regex : escape_html_regex, (match) => {
		if (match.length === 2) return match;
		return dict[match] ?? `&#${match.charCodeAt(0)};`;
	});
}
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/runtime/server/utils.js
/** @import { ServerHooks } from 'types' */
/**
* @param {Partial<Record<import('types').HttpMethod, any>>} mod
* @param {import('types').HttpMethod} method
*/
function method_not_allowed(mod, method) {
	return text(`${method} method not allowed`, {
		status: 405,
		headers: { allow: allowed_methods(mod).join(", ") }
	});
}
/** @param {Partial<Record<import('types').HttpMethod, any>>} mod */
function allowed_methods(mod) {
	const allowed = ENDPOINT_METHODS.filter((method) => method in mod);
	if ("GET" in mod && !("HEAD" in mod)) allowed.push("HEAD");
	return allowed;
}
/**
* @param {import('types').SSROptions} options
*/
function get_global_name(options) {
	return `__sveltekit_${options.version_hash}`;
}
/**
* Return as a response that renders the error.html
*
* @param {import('types').SSROptions} options
* @param {number} status
* @param {string} message
*/
function static_error_page(options, status, message) {
	return text(options.templates.error({
		status,
		message: escape_html(message)
	}), {
		headers: { "content-type": "text/html; charset=utf-8" },
		status
	});
}
/**
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {import('types').RequestState} state
* @param {import('types').SSROptions} options
* @param {unknown} error
*/
async function handle_fatal_error(event, state, options, error) {
	error = error instanceof HttpError ? error : coalesce_to_error(error);
	const body = await handle_error_and_jsonify(event, state, options, error);
	const status = body.status;
	const type = negotiate(event.request.headers.get("accept") || "text/html", ["application/json", "text/html"]);
	if (event.isDataRequest || type === "application/json") return json(body, { status });
	return static_error_page(options, status, body.message);
}
/**
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {import('types').RequestState} state
* @param {import('types').SSROptions} options
* @param {any} error
* @returns {App.Error | Promise<App.Error>}
*/
function handle_error_and_jsonify(event, state, options, error) {
	if (error instanceof HttpError) return {
		message: "Unknown Error",
		...error.body
	};
	const status = get_status(error);
	const message = get_message(error);
	const result = with_request_store({
		event,
		state
	}, () => options.hooks.handleError({
		error,
		event,
		status,
		message
	})) ?? {
		status,
		message
	};
	if (result instanceof Promise) {
		if (state.is_in_render) {
			console.warn(`To use an async \`handleError\` hook to handle errors that occur during rendering, you must enable \`compilerOptions.experimental.async\` in the SvelteKit plugin of your Vite config. The returned error has been replaced with a generic object`);
			result.catch(() => {});
			return {
				status,
				message: "Internal Error"
			};
		}
		return result.then((body) => {
			body ??= {
				status,
				message
			};
			return {
				...body,
				status: get_status(body, error)
			};
		});
	}
	return {
		...result,
		status: get_status(result, error)
	};
}
/**
* @param {number} status
* @param {string} location
*/
function redirect_response(status, location) {
	return new Response(void 0, {
		status,
		headers: { location }
	});
}
/**
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {Error & { path: string }} error
*/
function clarify_devalue_error(event, error) {
	if (error.path) return `Data returned from \`load\` while rendering ${event.route.id} is not serializable: ${error.message} (${error.path}). If you need to serialize/deserialize custom types, use transport hooks: https://svelte.dev/docs/kit/hooks#Universal-hooks-transport.`;
	if (error.path === "") return `Data returned from \`load\` while rendering ${event.route.id} is not a plain object`;
	return error.message;
}
/**
* @param {import('types').ServerDataNode} node
*/
function serialize_uses(node) {
	const uses = {};
	if (node.uses && node.uses.dependencies.size > 0) uses.dependencies = Array.from(node.uses.dependencies);
	if (node.uses && node.uses.search_params.size > 0) uses.search_params = Array.from(node.uses.search_params);
	if (node.uses && node.uses.params.size > 0) uses.params = Array.from(node.uses.params);
	if (node.uses?.parent) uses.parent = 1;
	if (node.uses?.route) uses.route = 1;
	if (node.uses?.url) uses.url = 1;
	return uses;
}
/**
* Returns `true` if the given path was prerendered
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @param {string} pathname Should include the base and be decoded
*/
function has_prerendered_path(manifest, pathname) {
	return manifest._.prerendered_routes.has(pathname) || pathname.at(-1) === "/" && manifest._.prerendered_routes.has(pathname.slice(0, -1));
}
/**
* Formats the error into a nice message with sanitized stack trace
* @param {number} status
* @param {Error} error
* @param {import('@sveltejs/kit').RequestEvent} event
*/
function format_server_error(status, error, event) {
	const formatted_text = `\n\x1b[1;31m[${status}] ${event.request.method} ${event.url.pathname}\x1b[0m`;
	if (status === 404) return formatted_text;
	return `${formatted_text}\n${error.stack}`;
}
/**
* Returns the filename without the extension. e.g., `+page.server`, `+page`, etc.
* @param {string | undefined} node_id
* @returns {string}
*/
function get_node_type(node_id) {
	const filename = (node_id?.split("/"))?.at(-1);
	if (!filename) return "unknown";
	return filename.split(".").slice(0, -1).join(".");
}
/**
* Counts HTML comments that are not SSI directives (which start with `<!--#`).
* Used to detect when `transformPageChunk` removes comments that Svelte needs for hydration.
* @param {string} str
* @returns {number}
*/
function count_non_ssi_comments(str) {
	return (str.match(/<!--(?!#)/g) ?? []).length;
}
/**
* Creates a serialiser for non-arbitrary POJOs using the app's transport hook
* @param {ServerHooks['transport']} transport
* @returns {(thing: unknown) => string | undefined}
*/
function create_replacer(transport) {
	/** @param {unknown} thing */
	const replacer = (thing) => {
		for (const key in transport) {
			const encoded = transport[key].encode(thing);
			if (encoded) return `app.decode('${key}', ${uneval(encoded, replacer)})`;
		}
	};
	return replacer;
}
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/runtime/shared.js
/** @import { Transport } from '@sveltejs/kit' */
/**
* @param {string} route_id
* @param {string} dep
*/
function validate_depends(route_id, dep) {
	const match = /^(moz-icon|view-source|jar):/.exec(dep);
	if (match) console.warn(`${route_id}: Calling \`depends('${dep}')\` will throw an error in Firefox because \`${match[1]}\` is a special URI scheme`);
}
var INVALIDATED_PARAM = "x-sveltekit-invalidated";
var TRAILING_SLASH_PARAM = "x-sveltekit-trailing-slash";
/**
* @param {any} data
* @param {string} [location_description]
*/
function validate_load_response(data, location_description) {
	if (data != null && Object.getPrototypeOf(data) !== Object.prototype) throw new Error(`a load function ${location_description} returned ${typeof data !== "object" ? `a ${typeof data}` : data instanceof Response ? "a Response object" : Array.isArray(data) ? "an array" : "a non-plain object"}, but must return a plain object at the top level (i.e. \`return {...}\`)`);
}
/**
* Try to `devalue.stringify` the data object using the provided transport encoders.
* @param {any} data
* @param {Transport} transport
*/
function stringify(data, transport) {
	return stringify$1(data, Object.fromEntries(Object.entries(transport).map(([k, v]) => [k, v.encode])));
}
var object_proto_names = /* @__PURE__ */ Object.getOwnPropertyNames(Object.prototype).sort().join("\0");
/**
* @param {unknown} thing
* @returns {thing is Record<PropertyKey, unknown>}
*/
function is_plain_object(thing) {
	if (typeof thing !== "object" || thing === null) return false;
	const proto = Object.getPrototypeOf(thing);
	return proto === Object.prototype || proto === null || Object.getPrototypeOf(proto) === null || Object.getOwnPropertyNames(proto).sort().join("\0") === object_proto_names;
}
/**
* @param {Record<string, any>} value
* @param {Map<object, any>} clones
*/
function to_sorted(value, clones) {
	const clone = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
	clones.set(value, clone);
	Object.defineProperty(clone, remote_arg_marker, { value: true });
	for (const key of Object.keys(value).sort()) {
		const property = value[key];
		Object.defineProperty(clone, key, {
			value: clones.get(property) ?? property,
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return clone;
}
var remote_object = "__skrao";
var remote_map = "__skram";
var remote_set = "__skras";
var remote_file = "__skraf";
var remote_regex_guard = "__skrag";
var remote_arg_marker = Symbol(remote_object);
/**
* @param {Transport} transport
* @param {boolean} sort
* @param {Map<any, any>} remote_arg_clones
*/
function create_remote_arg_reducers(transport, sort, remote_arg_clones) {
	/** @type {Record<string, (value: unknown) => unknown>} */
	const remote_fns_reducers = { 
	/** @param {unknown} value */
[remote_regex_guard]: (value) => {
		if (value instanceof RegExp) throw new Error("Regular expressions are not valid remote function arguments");
	} };
	if (sort) {
		/** @type {(value: unknown) => Array<[unknown, unknown]> | undefined} */
		remote_fns_reducers[remote_map] = (value) => {
			if (!(value instanceof Map)) return;
			/** @type {Array<[string, string]>} */
			const entries = [];
			for (const [key, val] of value) entries.push([stringify(key), stringify(val)]);
			return entries.sort(([a1, a2], [b1, b2]) => {
				if (a1 < b1) return -1;
				if (a1 > b1) return 1;
				if (a2 < b2) return -1;
				if (a2 > b2) return 1;
				return 0;
			});
		};
		/** @type {(value: unknown) => unknown[] | undefined} */
		remote_fns_reducers[remote_set] = (value) => {
			if (!(value instanceof Set)) return;
			/** @type {string[]} */
			const items = [];
			for (const item of value) items.push(stringify(item));
			items.sort();
			return items;
		};
		/** @type {(value: unknown) => Record<PropertyKey, unknown> | undefined} */
		remote_fns_reducers[remote_object] = (value) => {
			if (!is_plain_object(value)) return;
			if (Object.hasOwn(value, remote_arg_marker)) return;
			if (remote_arg_clones.has(value)) return remote_arg_clones.get(value);
			return to_sorted(value, remote_arg_clones);
		};
	}
	const all_reducers = {
		...Object.fromEntries(Object.entries(transport).map(([k, v]) => [k, v.encode])),
		...remote_fns_reducers
	};
	/** @type {(value: unknown) => string} */
	const stringify = (value) => stringify$1(value, all_reducers);
	return all_reducers;
}
/** @param {Transport} transport */
function create_remote_arg_revivers(transport) {
	const remote_fns_revivers = {
		/** @type {(value: unknown) => unknown} */
		[remote_object]: (value) => value,
		/** @type {(value: unknown) => Map<unknown, unknown>} */
		[remote_map]: (value) => {
			if (!Array.isArray(value)) throw new Error("Invalid data for Map reviver");
			const map = /* @__PURE__ */ new Map();
			for (const item of value) {
				if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string") throw new Error("Invalid data for Map reviver");
				const [key, val] = item;
				map.set(parse$1(key), parse$1(val));
			}
			return map;
		},
		/** @type {(value: unknown) => Set<unknown>} */
		[remote_set]: (value) => {
			if (!Array.isArray(value)) throw new Error("Invalid data for Set reviver");
			const set = /* @__PURE__ */ new Set();
			for (const item of value) {
				if (typeof item !== "string") throw new Error("Invalid data for Set reviver");
				set.add(parse$1(item));
			}
			return set;
		},
		/** @type {(value: any) => File} */
		[remote_file]: (value) => {
			if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.type !== "string" || typeof value.size !== "number" || typeof value.lastModified !== "number" || !(value.data instanceof ArrayBuffer)) throw new Error("Invalid data for File reviver");
			const { data, name, ...meta } = value;
			return new File([data], name, meta);
		}
	};
	const all_revivers = {
		...Object.fromEntries(Object.entries(transport).map(([k, v]) => [k, v.decode])),
		...remote_fns_revivers
	};
	/** @type {(data: string) => unknown} */
	const parse$1 = (data) => parse(data, all_revivers);
	return all_revivers;
}
/**
* Stringifies the argument (if any) for a remote function in such a way that
* it is both a valid URL and a valid file name (necessary for prerendering).
* @param {any} value
* @param {Transport} transport
*/
function stringify_remote_arg(value, transport) {
	if (value === void 0) return "";
	return url_friendly_base64_encode(stringify$1(value, create_remote_arg_reducers(transport, true, /* @__PURE__ */ new Map())));
}
/**
* Base64-encodes `string` in such a way that the result is safe to use
* as both a URI component and a filename
* @param {string} string
*/
function url_friendly_base64_encode(string) {
	return base64_encode(text_encoder.encode(string)).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
}
/**
* Parses the argument (if any) for a remote function
* @param {string} string
* @param {Transport} transport
*/
function parse_remote_arg(string, transport) {
	if (!string) return void 0;
	return parse(new TextDecoder().decode(base64_decode(string.replaceAll("-", "+").replaceAll("_", "/"))), create_remote_arg_revivers(transport));
}
/**
* @param {string} id
* @param {string} payload
*/
function create_remote_key(id, payload) {
	return id + "/" + payload;
}
/**
* @param {string} key
* @returns {{ id: string; payload: string }}
*/
function split_remote_key(key) {
	const i = key.lastIndexOf("/");
	if (i === -1) throw new Error(`Invalid remote key: ${key}`);
	return {
		id: key.slice(0, i),
		payload: key.slice(i + 1)
	};
}
//#endregion
export { deserialize_binary_form as A, MUTATIVE_METHODS as B, escape_html as C, negotiate as D, is_form_content_type as E, get_relative_path as F, SVELTE_KIT_ASSETS as H, text_encoder as I, stringify$1 as L, normalize_issue as M, set_nested_value as N, create_field_proxy as O, base64_encode as P, parse as R, static_error_page as S, normalize_error as T, noop as U, PAGE_METHODS as V, once as W, handle_fatal_error as _, split_remote_key as a, redirect_response as b, validate_depends as c, count_non_ssi_comments as d, create_replacer as f, handle_error_and_jsonify as g, get_node_type as h, parse_remote_arg as i, flatten_issues as j, deep_set as k, validate_load_response as l, get_global_name as m, TRAILING_SLASH_PARAM as n, stringify as o, format_server_error as p, create_remote_key as r, stringify_remote_arg as s, INVALIDATED_PARAM as t, clarify_devalue_error as u, has_prerendered_path as v, get_status as w, serialize_uses as x, method_not_allowed as y, ENDPOINT_METHODS as z };
