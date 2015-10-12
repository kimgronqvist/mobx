/**
 * mobservable
 * (c) 2015 - Michel Weststrate
 * https://github.com/mweststrate/mobservable
 */

import {isComputingView} from './dnode';
import {Lambda, IObservableArray, IObservableValue, IContextInfoStruct, IContextInfo} from './interfaces';
import {isPlainObject, once} from './utils';
import {ObservableValue} from './observablevalue';
import {ObservableView, throwingViewSetter} from './observableview';
import {ObservableArray} from './observablearray';
import {ObservableObject} from './observableobject';
import {transaction} from './scheduler';

/**
    * Turns an object, array or function into a reactive structure.
    * @param value the value which should become observable.
    */
export function observable(target:Object, key:string, baseDescriptor?:PropertyDescriptor):any;
export function observable<T>(value: T[]): IObservableArray<T>;
export function observable<T, S extends Object>(value: ()=>T, thisArg?: S): IObservableValue<T>;
export function observable<T extends string|number|boolean|Date|RegExp|Function|void>(value: T): IObservableValue<T>;
export function observable<T extends Object>(value: T): T;
export function observable(v:any, keyOrScope?:string | any) {
    if (typeof arguments[1] === "string")
        return observableDecorator.apply(null, arguments);

    if (isObservable(v))
        return v;

    let [mode, value] = getValueModeFromValue(v, ValueMode.Recursive);
    const sourceType = mode === ValueMode.Reference ? ValueType.Reference : getTypeOfValue(value);

    switch(sourceType) {
        case ValueType.Reference:
        case ValueType.ComplexObject:
            return toGetterSetterFunction(new ObservableValue(value, mode, null));
        case ValueType.ComplexFunction:
            throw new Error("[mobservable.makeReactive] Creating reactive functions from functions with multiple arguments is currently not supported, see https://github.com/mweststrate/mobservable/issues/12");
        case ValueType.ViewFunction: {
            const context = {
                name: value.name,
                object: value
            };
            return toGetterSetterFunction(new ObservableView(value, keyOrScope, context, mode === ValueMode.Structure));
        }
        case ValueType.Array:
        case ValueType.PlainObject:
            return makeChildObservable(value, mode, null);
    }
    throw "Illegal State";
}

/**
    * Can be used in combination with makeReactive / extendReactive.
    * Enforces that a reference to 'value' is stored as property,
    * but that 'value' itself is not turned into something reactive.
    * Future assignments to the same property will inherit this behavior.
    * @param value initial value of the reactive property that is being defined.
    */
export function asReference<T>(value:T):T {
    // unsound typecast, but in combination with makeReactive, the end result should be of the correct type this way
    // e.g: makeReactive({ x : asReference(number)}) -> { x : number }
    return <T><any> new AsReference(value);
}

/**
    * Can be used in combination with makeReactive / extendReactive.
    * Enforces that values that are deeply equalled identical to the previous are considered to unchanged.
    * (the default equality used by mobservable is reference equality).
    * Values that are still reference equal, but not deep equal, are considered to be changed.
    * asStructure can only be used incombinations with arrays or objects.
    * It does not support cyclic structures.
    * Future assignments to the same property will inherit this behavior.
    * @param value initial value of the reactive property that is being defined.
    */
export function asStructure<T>(value:T):T {
    return <T><any>new AsStructure(value);
}

/**
    * Can be used in combination with makeReactive / extendReactive.
    * The value will be made reactive, but, if the value is an object or array,
    * children will not automatically be made reactive as well.
    */
export function asFlat<T>(value:T):T {
    return <T><any> new AsFlat(value);
}

/**
    * Returns true if the provided value is reactive.
    * @param value object, function or array
    * @param propertyName if propertyName is specified, checkes whether value.propertyName is reactive.
    */
export function isObservable(value):boolean {
    if (value === null || value === undefined)
        return false;
    return !!value.$mobservable;
}

/**
    * Creates a reactive view and keeps it alive, so that the view is always
    * updated if one of the dependencies changes, even when the view is not further used by something else.
    * @param view The reactive view
    * @param scope (optional)
    * @returns disposer function, which can be used to stop the view from being updated in the future.
    */
export function observe(view:Lambda, scope?:any):Lambda {
    var [mode, unwrappedView] = getValueModeFromValue(view,ValueMode.Recursive);
    const observable = new ObservableView(unwrappedView, scope, {
        object: scope || view,
        name: view.name
    }, mode === ValueMode.Structure);
    observable.setRefCount(+1);

    const disposer = once(() => {
        observable.setRefCount(-1);
    });
    if (logLevel >= 2 && observable.observing.length === 0)
        console.warn(`[mobservable.observe] not a single observable was used inside the observing function. This observer is now a no-op.`);
    (<any>disposer).$mobservable = observable;
    return disposer;
}

/**
    * Similar to 'observer', observes the given predicate until it returns true.
    * Once it returns true, the 'effect' function is invoked an the observation is cancelled.
    * @param predicate
    * @param effect
    * @param scope (optional)
    * @returns disposer function to prematurely end the observer.
    */
export function observeUntil(predicate: ()=>boolean, effect: Lambda, scope?: any): Lambda {
    const disposer = observe(() => {
        if (predicate.call(scope)) {
            disposer();
            effect.call(scope);
        }
    });
    return disposer;
}

/**
    * Once the view triggers, effect will be scheduled in the background.
    * If observer triggers multiple times, effect will still be triggered only once, so it achieves a similar effect as transaction.
    * This might be useful for stuff that is expensive and doesn't need to happen synchronously; such as server communication.
    * Afther the effect has been fired, it can be scheduled again if the view is triggered in the future.
    * 
    * @param view to observe. If it returns a value, the latest returned value will be passed into the scheduled effect.
    * @param the effect that will be executed, a fixed amount of time after the first trigger of 'view'.
    * @param delay, optional. After how many milleseconds the effect should fire.
    * @param scope, optional, the 'this' value of 'view' and 'effect'.
    */
export function observeAsync<T>(view: () => T, effect: (latestValue : T ) => void, delay:number = 1, scope?: any): Lambda {
    var latestValue: T = undefined;
    var timeoutHandle;

    const disposer = observe(() => {
        latestValue = view.call(scope);
        if (!timeoutHandle) {
            timeoutHandle = setTimeout(() => {
                effect.call(scope, latestValue);
                timeoutHandle = null;
            }, delay);
        }
    });

    return once(() => {
        disposer();
        if (timeoutHandle)
            clearTimeout(timeoutHandle);
    });
}

/**
    * expr can be used to create temporarily views inside views.
    * This can be improved to improve performance if a value changes often, but usually doesn't affect the outcome of an expression.
    * 
    * In the following example the expression prevents that a component is rerender _each time_ the selection changes;
    * instead it will only rerenders when the current todo is (de)selected.
    * 
    * reactiveComponent((props) => {
    *     const todo = props.todo;
    *     const isSelected = mobservable.expr(() => props.viewState.selection === todo);
    *     return <div className={isSelected ? "todo todo-selected" : "todo"}>{todo.title}</div>
    * });
    * 
    */
export function expr<T>(expr: () => T, scope?):T {
    if (!isComputingView())
        throw new Error("[mobservable.expr] 'expr' can only be used inside a computed value.");
    return observable(expr, scope) ();
}

/**
    * Extends an object with reactive capabilities.
    * @param target the object to which reactive properties should be added
    * @param properties the properties that should be added and made reactive
    * @returns targer
    */
export function extendObservable<A extends Object, B extends Object>(target: A, properties: B, context?: IContextInfoStruct): A & B {
    return <A & B> extendObservableHelper(target, properties,ValueMode.Recursive, context) 
}

/**
    * ES6 / Typescript decorator which can to make class properties and getter functions reactive.
    * Use this annotation to wrap properties of an object in an observable, for example:
    * class OrderLine {
    *   @observable amount = 3;
    *   @observable price = 2;
    *   @observable total() {
    *      return this.amount * this.price;
    *   }
    * }
    */
function observableDecorator(target:Object, key:string, baseDescriptor:PropertyDescriptor) {
    // - In typescript, observable annotations are invoked on the prototype, not on actual instances,
    // so upon invocation, determine the 'this' instance, and define a property on the
    // instance as well (that hides the propotype property)
    // - In typescript, the baseDescriptor is empty for attributes without initial value
    // - In babel, the initial value is passed as the closure baseDiscriptor.initializer' 
    
    const isDecoratingGetter = baseDescriptor && baseDescriptor.hasOwnProperty("get");
    const descriptor:PropertyDescriptor = {};
    let baseValue = undefined;
    if (baseDescriptor) {
        if (baseDescriptor.hasOwnProperty('get'))
            baseValue = baseDescriptor.get;
        else if (baseDescriptor.hasOwnProperty('value'))
            baseValue = baseDescriptor.value;
        else if ((<any>baseDescriptor).initializer) { // For babel
            baseValue = (<any>baseDescriptor).initializer();
            if (typeof baseValue === "function")
                baseValue = asReference(baseValue);
        }
    }

    if (!target || typeof target !== "object")
        throw new Error(`The @observable decorator can only be used on objects`);
    if (isDecoratingGetter) {
        if (typeof baseValue !== "function")
            throw new Error(`@observable expects a getter function if used on a property (in member: '${key}').`);
        if (descriptor.set)
            throw new Error(`@observable properties cannot have a setter (in member: '${key}').`);
        if (baseValue.length !== 0)
            throw new Error(`@observable getter functions should not take arguments (in member: '${key}').`);
    }

    descriptor.configurable = true;
    descriptor.enumerable = true;
    descriptor.get = function() {
        // the getter creates a reactive property lazily, so this might even happen during a view.
        const baseStrict = strict;
        strict = false;
        ObservableObject.asReactive(this, null,ValueMode.Recursive).set(key, baseValue);
        strict = baseStrict;
        return this[key];
    };
    descriptor.set = isDecoratingGetter 
        ? throwingViewSetter(key)
        : function(value) { 
            ObservableObject.asReactive(this, null,ValueMode.Recursive).set(key, typeof value === "function" ? asReference(value) : value); 
        }
    ;
    if (!baseDescriptor) {
        Object.defineProperty(target, key, descriptor); // For typescript
    } else { 
        return descriptor;
    }
}

/**
    * Basically, a deep clone, so that no reactive property will exist anymore.
    * Doesn't follow references.
    */
export function toJSON(source) {
    if (!source)
        return source;
    if (Array.isArray(source) || source instanceof ObservableArray)
        return source.map(toJSON);
    if (typeof source === "object" && isPlainObject(source)) {
        var res = {};
        for (var key in source) if (source.hasOwnProperty(key))
            res[key] = toJSON(source[key]);
        return res;
    }
    return source;
}

/**
    * During a transaction no views are updated until the end of the transaction.
    * The transaction will be run synchronously nonetheless.
    * @param action a function that updates some reactive state
    * @returns any value that was returned by the 'action' parameter.
    */
export function transaction<T>(action:()=>T):T {
    return transaction(action);
}

/**
    * Sets the reporting level Defaults to 1. Use 0 for production or 2 for increased verbosity.
    */
var logLevel = 1; // 0 = production, 1 = development, 2 = debugging
export function getLogLevel() {
    return logLevel;
}
export function setLogLevel(newLogLevel) {
    logLevel = newLogLevel;
}

/**
    * If strict is enabled, views are not allowed to modify the state.
    * This is a recommended practice, as it makes reasoning about your application simpler.
    */
var strict = true;
export function getStrict() {
    return strict;
}
export function setStrict(newStrict) {
    strict = newStrict;
}

setTimeout(function() {
    if (logLevel > 0)
        console.info(`Welcome to mobservable. Current logLevel = ${logLevel}. Change mobservable.logLevel according to your needs: 0 = production, 1 = development, 2 = debugging. Strict mode is ${strict ? 'enabled' : 'disabled'}.`);
}, 1);

/**
 * Internal methods
 */

export enum ValueType { Reference, PlainObject, ComplexObject, Array, ViewFunction, ComplexFunction }

export enum ValueMode {
	Recursive, // If the value is an plain object, it will be made reactive, and so will all its future children.
	Reference, // Treat this value always as a reference, without any further processing.
	Structure, // Similar to recursive. However, this structure can only exist of plain arrays and objects.
				// No observers will be triggered if a new value is assigned (to a part of the tree) that deeply equals the old value.
	Flat       // If the value is an plain object, it will be made reactive, and so will all its future children.
}

export function getTypeOfValue(value): ValueType {
	if (value === null || value === undefined)
		return ValueType.Reference;
	if (typeof value === "function")
		return value.length ? ValueType.ComplexFunction : ValueType.ViewFunction;
	if (Array.isArray(value) || value instanceof ObservableArray)
		return ValueType.Array;
	if (typeof value == 'object')
		return isPlainObject(value) ? ValueType.PlainObject : ValueType.ComplexObject;
	return ValueType.Reference; // safe default, only refer by reference..
}

export function extendObservableHelper(target, properties, mode: ValueMode, context: IContextInfoStruct):Object {
	var meta = ObservableObject.asReactive(target, context, mode);
	for(var key in properties) if (properties.hasOwnProperty(key)) {
		meta.set(key, properties[key]);
	}
	return target;
}

export function toGetterSetterFunction<T>(observable: ObservableValue<T> | ObservableView<T>):IObservableValue<T> {
	var f:any = function(value?) {
		if (arguments.length > 0)
			observable.set(value);
		else
			return observable.get();
	};
	f.$mobservable = observable;
	f.observe = function(listener, fire) {
		return observable.observe(listener, fire);
	}
	f.toString = function() {
		return observable.toString();
	}
	return f;
}

export class AsReference {
	constructor(public value:any) {
		assertUnwrapped(value, "Modifiers are not allowed to be nested");
	}
}

export class AsStructure {
	constructor(public value:any) {
		assertUnwrapped(value, "Modifiers are not allowed to be nested");
	}
}

export class AsFlat {
	constructor(public value:any) {
		assertUnwrapped(value, "Modifiers are not allowed to be nested");
	}
}

export function getValueModeFromValue(value:any, defaultMode:ValueMode): [ValueMode, any] {
	if (value instanceof AsReference)
		return [ValueMode.Reference, value.value];
	if (value instanceof AsStructure)
		return [ValueMode.Structure, value.value];
	if (value instanceof AsFlat)
		return [ValueMode.Flat, value.value];
	return [defaultMode, value];
}

export function makeChildObservable(value, parentMode:ValueMode, context) {
	let childMode: ValueMode;
	if (isObservable(value))
		return value;

	switch (parentMode) {
		case ValueMode.Reference:
			return value;
		case ValueMode.Flat:
			assertUnwrapped(value, "Items inside 'asFlat' canont have modifiers");
			childMode = ValueMode.Reference;
			break;
		case ValueMode.Structure:
			assertUnwrapped(value, "Items inside 'asStructure' canont have modifiers");
			childMode = ValueMode.Structure;
			break;
		case ValueMode.Recursive:
			[childMode, value] = getValueModeFromValue(value, ValueMode.Recursive);
			break;
		default:
			throw "Illegal State";
	}

	if (Array.isArray(value))
		return new ObservableArray(<[]> value.slice(), childMode, context);
	if (isPlainObject(value))
		return extendObservableHelper(value, value, childMode, context);
	return value;
}

export function assertUnwrapped(value, message) {
	if (logLevel === 0)
		return;
	if (value instanceof AsReference || value instanceof AsStructure || value instanceof AsFlat)
		throw new Error(`[mobservable] asStructure / asReference / asFlat cannot be used here. ${message}`);
}