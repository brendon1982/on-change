'use strict';

const {TARGET, UNSUBSCRIBE} = require('./lib/constants');
const isBuiltin = require('./lib/is-builtin');
const path = require('./lib/path');
const isSymbol = require('./lib/is-symbol');
const isIterator = require('./lib/is-iterator');
const wrapIterator = require('./lib/wrap-iterator');
const ignoreProperty = require('./lib/ignore-property');
const Cache = require('./lib/cache');
const SmartClone = require('./lib/smart-clone');

const defaultOptions = {
	equals: Object.is,
	isShallow: false,
	pathAsArray: false,
	ignoreSymbols: false,
	ignoreUnderscores: false,
	ignoreDetached: false,
	details: false
};

const onChange = (object, onChange, options = {}) => {
	options = {
		...defaultOptions,
		...options
	};
	const proxyTarget = Symbol('ProxyTarget');
	const {equals, isShallow, ignoreDetached, details} = options;
	const cache = new Cache(equals);
	const smartClone = new SmartClone();

	const handleChangeOnTarget = (target, property, value, previous) => {
		if (
			!ignoreProperty(cache, options, property) &&
			!(ignoreDetached && cache.isDetached(target, object))
		) {
			handleChange(cache.getPath(target), property, value, previous);
		}
	};

	// eslint-disable-next-line max-params
	const handleChange = (changePath, property, value, previous, applyData) => {
		if (smartClone.isCloning) {
			smartClone.update(changePath, property, previous);
		} else {
			onChange(path.concat(changePath, property), value, previous, applyData);
		}
	};

	const getProxyTarget = value => {
		if (value) {
			return value[proxyTarget] || value;
		}

		return value;
	};

	const prepareValue = (value, target, property, basePath) => {
		if (
			isBuiltin.withoutMutableMethods(value) ||
			property === 'constructor' ||
			(isShallow && !SmartClone.isHandledMethod(target, property)) ||
			ignoreProperty(cache, options, property) ||
			cache.isGetInvariant(target, property) ||
			(ignoreDetached && cache.isDetached(target, object))
		) {
			return value;
		}

		if (basePath === undefined) {
			basePath = cache.getPath(target);
		}

		return cache.getProxy(value, path.concat(basePath, property), handler, proxyTarget);
	};

	const handler = {
		get(target, property, receiver) {
			if (isSymbol(property)) {
				if (property === proxyTarget || property === TARGET) {
					return target;
				}

				if (
					property === UNSUBSCRIBE &&
					!cache.isUnsubscribed &&
					cache.getPath(target).length === 0
				) {
					cache.unsubscribe();
					return target;
				}
			}

			const value = isBuiltin.withMutableMethods(target) ?
				Reflect.get(target, property) :
				Reflect.get(target, property, receiver);

			return prepareValue(value, target, property);
		},

		set(target, property, value, receiver) {
			value = getProxyTarget(value);

			const reflectTarget = target[proxyTarget] || target;
			const previous = reflectTarget[property];
			const hasProperty = property in target;

			if (cache.setProperty(reflectTarget, property, value, receiver, previous)) {
				if (!equals(previous, value) || !hasProperty) {
					handleChangeOnTarget(target, property, value, previous);
				}

				return true;
			}

			return false;
		},

		defineProperty(target, property, descriptor) {
			if (!cache.isSameDescriptor(descriptor, target, property)) {
				if (!cache.defineProperty(target, property, descriptor)) {
					return false;
				}

				handleChangeOnTarget(target, property, descriptor.value);
			}

			return true;
		},

		deleteProperty(target, property) {
			if (!Reflect.has(target, property)) {
				return true;
			}

			const previous = Reflect.get(target, property);

			if (cache.deleteProperty(target, property, previous)) {
				handleChangeOnTarget(target, property, undefined, previous);

				return true;
			}

			return false;
		},

		apply(target, thisArg, argumentsList) {
			const thisProxyTarget = thisArg[proxyTarget] || thisArg;

			if (cache.isUnsubscribed) {
				return Reflect.apply(target, thisProxyTarget, argumentsList);
			}

			if (
				(details === false ||
					(details !== true && !details.includes(target.name))) &&
				SmartClone.isHandledType(thisProxyTarget)
			) {
				let applyPath = path.initial(cache.getPath(target));
				const isHandledMethod = SmartClone.isHandledMethod(thisProxyTarget, target.name);

				smartClone.start(thisProxyTarget, applyPath, argumentsList);

				let result = Reflect.apply(
					target,
					smartClone.preferredThisArg(target, thisArg, thisProxyTarget),
					isHandledMethod ?
						argumentsList.map(argument => getProxyTarget(argument)) :
						argumentsList
				);

				const isChanged = smartClone.isChanged(thisProxyTarget, equals, argumentsList);
				const clone = smartClone.stop();

				if (SmartClone.isHandledType(result) && isHandledMethod) {
					if (thisArg instanceof Map && target.name === 'get') {
						applyPath = path.concat(applyPath, argumentsList[0]);
					}
					result = cache.getProxy(result, applyPath, handler);
				}

				if (isChanged) {
					const applyData = {
						name: target.name,
						args: argumentsList,
						result
					};

					if (smartClone.isCloning) {
						handleChange(path.initial(applyPath), path.last(applyPath), thisProxyTarget, clone, applyData);
					} else {
						handleChange(applyPath, '', thisProxyTarget, clone, applyData);
					}
				}

				if (
					(thisArg instanceof Map || thisArg instanceof Set) &&
					isIterator(result)
				) {
					return wrapIterator(result, target, thisArg, applyPath, prepareValue);
				}

				return result;
			}

			return Reflect.apply(target, thisArg, argumentsList);
		}
	};

	const proxy = cache.getProxy(object, options.pathAsArray ? [] : '', handler);
	onChange = onChange.bind(proxy);

	return proxy;
};

onChange.target = proxy => proxy[TARGET] || proxy;
onChange.unsubscribe = proxy => proxy[UNSUBSCRIBE] || proxy;

module.exports = onChange;
