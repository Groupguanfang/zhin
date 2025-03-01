import { isBailed, remove, Dict } from "@zhinjs/shared";
import { Zhin, isConstructor, ChannelId } from "./zhin";
import { Dispose, ToDispose } from "./dispose";
import { Adapter, AdapterConstructs, AdapterOptions, AdapterOptionsType } from "./adapter";
import { Middleware } from "./middleware";
import { ArgsType, Command, defineCommand } from "./command";
import { NSession, Session } from "./session";
import { Element } from "./element";
import { EventEmitter } from "events";
import { Plugin, PluginMap } from "@/plugin";
import { Component, FunctionalComponent } from "./component";
import { Logger } from "log4js";
import { Bot } from "./bot";

export class Context extends EventEmitter {
    /**
     * zhin实体
     */
    zhin: Zhin;
    /**
     * 当前上下文产生的插件
     */
    plugins: PluginMap = new PluginMap();
    /**
     * 当前上下文产生的中间件
     */
    middlewares: Middleware[] = [];
    /**
     * 当前上下文产生的组件
     */
    components: Dict<Component> = Object.create(null);
    /**
     * 当前上下文产生的指令
     */
    commands: Map<string, Command> = new Map<string, Command>();
    /**
     * 卸载当前上下文需要执行的函数集合
     */
    public readonly disposes: Dispose[] = [];

    constructor(
        public parent: Context,
        public filter: Context.Filter = parent?.filter || Context.defaultFilter,
    ) {
        super();
        this[Context.childKey] = [];
        this[Context.plugin] = null;
        if (!parent) return;
        parent[Context.childKey].push(this);
        this.on("dispose", () => {
            remove(this.parent[Context.childKey], this);
        });
        this.zhin = parent.zhin;
        this.logger = parent.logger;
        return new Proxy(this, {
            get(target: Context, p: string | symbol, receiver: any): any {
                if (target.zhin.services.has(p as keyof Zhin.Services))
                    return target.zhin.services.get(p as keyof Zhin.Services);
                return Reflect.get(target, p, receiver);
            },
        });
    }

    /**
     * 上下文继承
     * @param ctx
     */
    extend(ctx: Partial<Context>) {
        Object.assign(this, ctx);
        return this;
    }

    /**
     * 选择values包含会话中指定key值的上下文
     * @param key session的key
     * @param values 对应key可以为哪些值
     */
    pick<K extends keyof Session>(key: K, ...values: Session[K][]) {
        return this.and(Session.checkProp(key, ...values));
    }

    /**
     * 将当前上下文的过滤器与另一个过滤器进行与操作
     * @param filter
     */
    and(filter: Context.Filter) {
        return Context.from(this, Context.and(this, filter));
    }

    /**
     * 将当前上下文的过滤器与另一个过滤器进行或操作
     * @param filter 过滤器
     */
    or(filter: Context.Filter) {
        return Context.from(this, Context.or(this, filter));
    }

    /**
     * 将当前上下文的过滤器与另一个过滤器进行非操作
     * @param filter 过滤器
     */
    not(filter: Context.Filter) {
        return Context.from(this, Context.not(this, filter));
    }

    /**
     * 筛选带用户id的上下文
     * @param user_ids 用户id数组
     */
    user(...user_ids: (string | number)[]) {
        return this.pick("user_id", ...user_ids);
    }

    /**
     * 获取指定角色类型的上下文
     * @param roles
     */
    role(...roles: Bot.Authority[]) {
        return this.and(session => {
            return roles.some(role => {
                if (role === "master") return session.isMaster;
                if (role === "admin") return session.isAdmin;
                if (role === "owner") return session.isOwner;
                return session.isAdmins;
            });
        });
    }

    admin(...admin_ids: (string | number)[]) {
        return this.role("admin").user(...admin_ids);
    }

    owner(...owner_ids: (string | number)[]) {
        return this.role("owner").user(...owner_ids);
    }

    admins(...admin_ids: (string | number)[]) {
        return this.role("admins").user(...admin_ids);
    }

    master(...master_ids: (string | number)[]) {
        return this.role("master").user(...master_ids);
    }

    /**
     * 筛选群聊上下文
     * @param group_ids 群id数组
     */
    group(...group_ids: (string | number)[]) {
        return this.pick("group_id", ...group_ids);
    }

    /**
     * 筛选讨论组上下文
     * @param discuss_ids 讨论组id数组
     */
    discuss(...discuss_ids: (string | number)[]) {
        return this.pick("discuss_id", ...discuss_ids);
    }

    /**
     * 筛选频道上下文
     * @param guild_ids 频道id数组
     */
    guild(...guild_ids: string[]) {
        return this.pick("guild_id", ...guild_ids);
    }

    /**
     * 筛选子频道上下文
     * @param channel_ids 自频道id数组
     */
    channel(...channel_ids: string[]) {
        return this.pick("channel_id", ...channel_ids);
    }

    /**
     * 筛选指定平台的上下文
     * @param platforms 平台类型数组
     */
    platform(...platforms: (keyof Zhin.Adapters)[]) {
        return this.pick("protocol", ...platforms);
    }

    /**
     * 筛选私聊上下文
     * @param user_ids 用户id数组
     */
    private(...user_ids: (string | number)[]) {
        return this.pick("detail_type", "private").pick("user_id", ...user_ids);
    }

    /**
     * zhin日志记录器
     */
    public logger: Logger;

    /**
     * 获取当前上下文所有插件
     */
    get pluginList(): Plugin[] {
        const result = [...this.plugins.values()].reduce(
            (result, plugin) => {
                if (plugin.context !== this) result.push(...plugin.context.pluginList);
                return result;
            },
            [...this.plugins.values()],
        );
        return result;
    }

    /**
     * 根据会话获取匹配的上下文
     * @param session 会话实体
     */
    getMatchedContextList<P extends keyof Zhin.Adapters>(session: NSession<P>): Context[] {
        return this[Context.childKey]
            .reduce(
                (result, ctx) => {
                    if (session.match(ctx)) result.push(ctx, ...ctx.getMatchedContextList(session));
                    return result;
                },
                [...this.plugins.values()].map(p => p.context),
            )
            .filter(ctx => {
                if (!ctx[Context.plugin]) return session.match(ctx);
                const plugin = ctx[Context.plugin];
                return (
                    session.match(ctx) &&
                    plugin.status &&
                    session.bot.match(plugin) &&
                    plugin.match(session)
                );
            });
    }

    /**
     * 为当前上下文添加插件
     * @param name 插件名
     * @param setup 是否setup插件
     */
    plugin(name: string, setup?: boolean): Plugin | this;
    /**
     * 为当前上下文添加插件
     * @param plugin 插件安装配置对象
     */
    plugin<P extends Plugin.Install>(plugin: P): this;
    plugin<P extends Plugin.Install>(entry: string | P, setup?: boolean) {
        let options: Plugin.Options;
        if (typeof entry === "string") {
            const result = this.plugins.get(entry);
            if (result) return result;
            options = this.zhin.load(entry, "plugin", setup);
        } else {
            options = Plugin.defineOptions(entry);
        }
        const info: Plugin.Info = Plugin.getInfo(options.fullPath);
        const installPlugin = () => {
            const context = new Context(this);
            const plugin = new Plugin(options, info);
            if (this.plugins.get(options.fullName)) {
                this.zhin.logger.warn("重复载入:" + options.name);
                return;
            }
            this.plugins.set(options.fullName, plugin);
            plugin.mount(context);
            this.zhin.logger.debug(`已载入插件:${options.name}`);
            this.zhin.emit("plugin-add", plugin);
            return plugin;
        };
        const use = (options.use ||= []);
        const plugin = installPlugin();
        if (!use.length) {
            if (use.some(name => !this.zhin.services.has(name))) {
                this.zhin.logger.warn(`插件(${options.name})所需服务(${use.join()})未就绪，已停用`);
                plugin.disable();
            }
        }
        return this;
    }

    /**
     * 为当前上下文添加指令
     * @param nameDecl 指令名
     * @param command 指令对象
     */
    useCommand<A extends any[], O = {}>(nameDecl: string, command: Command<A, O>) {
        if (!nameDecl && !command.name) throw new Error("nameDecl不能为空");
        if (!nameDecl) nameDecl = command.name;
        const nameArr = nameDecl.split("/").filter(Boolean);
        const name = nameArr.pop();
        let parent: Command<any> | undefined;
        while (nameArr.length) {
            parent = this.zhin.findCommand(nameArr.shift());
            if (!parent) throw new Error(`找不到父指令:${nameArr.join("/")}`);
        }
        if (parent) {
            command.parent = parent;
            parent.children.push(command as unknown as Command);
        }
        command.name = name;
        this.commands.set(command.name, command as any);
        this.zhin.emit("command-add", command);
        this.disposes.push(() => {
            this.commands.delete(command.name);
            remove(command.parent?.children || [], command as any);
            this.zhin.emit("command-remove", command);
        });
    }

    /**
     * 在zhin就绪前执行回调函数，如果zhin已经就绪则立即执行
     * @param callback
     */
    async beforeReady(callback: () => Promise<any>): Promise<ToDispose<this>> {
        if (this.zhin.isReady) await callback();
        return this.zhin.on("before-ready", callback);
    }
    /**
     * 在zhin就绪后执行回调函数，如果zhin已经就绪则立即执行
     * @param callback 回调函数
     */
    async afterReady(callback: () => Promise<any>): Promise<ToDispose<this>> {
        if (this.zhin.isReady) await callback();
        return this.zhin.on("after-ready", callback);
    }
    /**
     * 在zhin启动前执行回调函数，如果zhin已经启动则立即执行
     * @param callback 回调函数
     */
    async beforeStart(callback: () => Promise<any>): Promise<ToDispose<this>> {
        if (this.zhin.isStarted) await callback();
        return this.zhin.on("before-start", callback);
    }
    /**
     * 在zhin启动后执行回调函数，如果zhin已经启动则立即执行
     * @param callback 回调函数
     */
    async afterStart(callback: () => Promise<any>): Promise<ToDispose<this>> {
        if (this.zhin.isStarted) await callback();
        return this.zhin.on("after-start", callback);
    }
    /**
     * 为当前上下文添加插件
     * @param plugin 插件安装配置对象
     */
    use<P extends Plugin.Install>(plugin: P): this {
        this.plugin(plugin);
        return this;
    }

    /**
     * 获取当前上下文所有中间件(包含子上下文中间件)
     */
    get middlewareList() {
        const result = [...this.plugins.values()].reduce(
            (result, plugin) => {
                if (plugin.context !== this) result.push(...plugin.context.middlewareList);
                return result;
            },
            [...this.middlewares],
        );
        if (this[Context.childKey]) {
            result.push(...this[Context.childKey].map(ctx => ctx.middlewareList).flat());
        }
        return result;
    }

    /**
     * 为当前上下文添加中间件
     * @param middleware 中间件
     * @param prepend 是否插入到最前端
     */
    middleware(middleware: Middleware, prepend?: boolean) {
        const method: "push" | "unshift" = prepend ? "unshift" : "push";
        this.middlewares[method](middleware);
        const dispose = Dispose.from(this, () => {
            return remove(this.middlewares, middleware);
        });
        this.disposes.push(dispose);
        return dispose;
    }

    /**
     * 获取当前上下文所有组件(包含自上下文组件)
     */
    get componentList(): Dict<Component> {
        const result = [...this.plugins.values()].reduce(
            (result, plugin) => {
                if (plugin.context !== this) Object.assign(result, plugin.context.componentList);
                return result;
            },
            { ...this.components },
        );
        if (this[Context.childKey]) {
            this[Context.childKey].map(ctx => {
                Object.assign(result, ctx.componentList);
            });
        }
        return result;
    }

    /**
     * 为当前上下文添加组件
     * @param component 添加的组件
     */
    component<T>(component: FunctionalComponent<T>): ToDispose<this>;
    /**
     * 为当前上下文添加组件
     * @param name 组件名(需确保唯一性)
     * @param component 添加的组件
     */
    component(name: string, component: Component): ToDispose<this>;
    component(name: string | FunctionalComponent, component?: Component) {
        if (typeof name === "function") {
            component = {
                render: name,
            };
            name = name.name;
        }
        if (this.components[name]) this.logger.warn(`组件(${name})已存在，将被覆盖`);
        this.components[name] = component;
        const dispose = Dispose.from(this, () => {
            delete this.components[name as string];
            remove(this.disposes, dispose);
        });
        this.disposes.push(dispose);
        return dispose;
    }

    /**
     * 获取当前上下文所有指令(包含子上下文指令)
     */
    get commandList(): Command[] {
        const result = [...this.plugins.values()].reduce(
            (result, plugin) => {
                if (plugin.context !== this) result.push(...plugin.context.commandList);
                return result;
            },
            [...this.commands.values()],
        );
        if (this[Context.childKey]) {
            result.push(...this[Context.childKey].map(ctx => ctx.commandList).flat());
        }
        return result;
    }

    /**
     * 为当前上下文添加指令
     * @param decl 指令声明
     * @param initialValue 指令初始值
     */
    command<S extends Command.Declare>(
        decl: S,
        initialValue?: ArgsType<Command.RemoveFirst<S>>,
    ): Command<ArgsType<Command.RemoveFirst<S>>>;
    /**
     * 为当前上下文添加指令
     * @param decl 指令声明
     * @param config {import('zhin').Command} 指令配置
     */
    command<S extends Command.Declare>(
        decl: S,
        config?: Command.Config,
    ): Command<ArgsType<Command.RemoveFirst<S>>>;
    /**
     * 为当前上下文添加指令
     * @param decl 指令声明
     * @param initialValue 指令初始值
     * @param config {import('zhin').Command} 指令配置
     */
    command<S extends Command.Declare>(
        decl: S,
        initialValue?: ArgsType<Command.RemoveFirst<S>>,
        config?: Command.Config,
    ): Command<ArgsType<Command.RemoveFirst<S>>>;
    command<S extends Command.Declare>(
        decl: S,
        ...args: (ArgsType<Command.RemoveFirst<S>> | Command.Config)[]
    ): Command<ArgsType<Command.RemoveFirst<S>>> {
        const [nameDecl, ...argsDecl] = decl.split(/\s+/);
        if (!nameDecl) throw new Error("nameDecl不能为空");
        const nameArr = nameDecl.split("/").filter(Boolean);
        const name = nameArr.pop();
        let parent: Command;
        while (nameArr.length) {
            parent = this.zhin.findCommand(nameArr.shift());
            if (!parent) throw new Error(`找不到父指令:${nameArr.join("/")}`);
        }
        const command = defineCommand(argsDecl.join(" "), ...(args as any));
        const filters = this.zhin.permissions[nameDecl];
        if (filters) command.setFilters(filters);
        if (parent) {
            command.parent = parent;
            parent.children.push(command as unknown as Command);
        }
        command.name = name;
        this.commands.set(name, command);
        this.zhin.emit("command-add", command);
        this.disposes.push(() => {
            this.commands.delete(name);
            this.zhin.emit("command-remove", command);
        });
        return command as Command<ArgsType<Command.RemoveFirst<S>>>;
    }

    /**
     * 查找指定名称的指令
     * @param name 指令名
     */
    findCommand(name: string) {
        return this.zhin.commandList.find(command => command.name === name);
    }

    /**
     * 监听事件
     * @param event 事件名
     * @param listener 回调函数
     */
    on(event, listener): ToDispose<this> {
        super.on(event, listener);
        const dispose = Dispose.from(this, () => {
            super.off(event, listener);
            remove(this.disposes, dispose);
        });
        this.disposes.push(dispose);
        return dispose;
    }

    /**
     * 往下级插件抛会话，普通开发者用不上
     */
    dispatch<P extends keyof Zhin.Adapters, E extends keyof Zhin.BotEventMaps[P]>(
        protocol: P,
        eventName: E,
        session: NSession<P, E>,
    ) {
        session.context = this;
        if (session.match(this)) {
            this.emit(`${protocol}.${String(eventName)}`, session);
            for (const context of this[Context.childKey]) {
                context.dispatch(protocol, eventName, session);
            }
        }
    }

    /**
     * 为zhin添加适配器，若已安装，则直接返回该服务，若未安装，会自动查询本地模块中`@zhinjs/adapter-${adapter}`。
     * @param adapter 适配平台
     */
    adapter<K extends keyof Zhin.Adapters>(adapter: K): Zhin.Adapters[K];
    /**
     * 为zhin添加适配器，若已安装，则直接返回该服务，若未安装，会自动查询本地模块中`@zhinjs/adapter-${adapter}`。
     * @param adapter 适配平台
     * @param options 初始化适配器时的配置
     */
    adapter<K extends keyof Zhin.Adapters>(
        adapter: K,
        options: AdapterOptionsType<Zhin.Adapters[K]>,
    ): this;
    /**
     * 为zhin添加适配器
     * @param adapter 适配平台
     * @param construct 适配器构造函数
     * @param options 初始化适配器时的配置
     */
    adapter<K extends keyof Zhin.Adapters>(
        adapter: K,
        construct: AdapterConstructs[K],
        options: AdapterOptionsType<Zhin.Adapters[K]>,
    ): this;
    adapter<K extends keyof Zhin.Adapters>(
        adapter: K,
        Construct?: AdapterConstructs[K] | AdapterOptions,
        options?: AdapterOptions,
    ) {
        if (!Construct && !options) return this.zhin.adapters.get(adapter);
        if (typeof Construct !== "function") {
            const result = this.zhin.load(adapter, "adapter", false);
            if (result && result.install) {
                result.install(this, options);
            }
            options = Construct as AdapterOptions;
            Construct = Adapter.get(adapter).Adapter;
        }
        if (!Construct) throw new Error(`can't find adapter for protocol:${adapter}`);
        const dispose = this.zhin.on(`${adapter}.message`, session => {
            this.zhin.emitSync("message", session);
        });
        this.zhin.adapters.set(adapter, new Construct(this.zhin, adapter, options) as any);
        return Dispose.from(this, () => {
            dispose();
            this.zhin.adapters.delete(adapter);
        }) as any;
    }

    /**
     * 为zhin添加服务，若已安装，则直接返回该服务，若未安装，会自动查询本地模块中`@zhinjs/service-${key}`。
     * @param key 服务名
     */
    service<K extends keyof Zhin.Services>(key: K): Zhin.Services[K];
    /**
     * 为zhin添加服务
     * @param key 服务名
     * @param service 服务实体
     */
    service<K extends keyof Zhin.Services>(key: K, service: Zhin.Services[K]): this;
    /**
     * 为zhin添加服务
     * @param key 服务名
     * @param constructor 服务构造函数
     * @param options 初始化服务时的配置
     */
    service<K extends keyof Zhin.Services, T>(
        key: K,
        constructor: Zhin.ServiceConstructor<Zhin.Services[K], T>,
        options?: T,
    ): this;
    service<K extends keyof Zhin.Services, T>(
        key: K,
        Service?: Zhin.Services[K] | Zhin.ServiceConstructor<Zhin.Services[K], T>,
        options?: T,
    ): Zhin.Services[K] | this {
        if (Service === undefined) {
            if (this.zhin.services.get(key)) return this.zhin.services.get(key);
            Service = this.zhin.load(key, "service", false) as
                | Zhin.Services[K]
                | Zhin.ServiceConstructor<Zhin.Services[K], T>;
        }
        if (this.zhin[key]) throw new Error("服务key不能和bot已有属性重复");
        if (this.zhin.services.has(key)) throw new Error("重复定义服务");
        if (isConstructor(Service)) {
            this.zhin.services.set(key, new Service(this, options));
        } else {
            this.zhin.services.set(key, Service);
        }
        this.zhin.logger.debug(`已挂载服务(${key})`);
        this.zhin.emit("service-add", key);
        const dispose = Dispose.from(this, () => {
            this.zhin.logger.debug(`已卸载服务(${key})`);
            this.zhin.services.delete(key);
            this.zhin.emit("service-remove", key);
            remove(this.disposes, dispose);
        });
        this.disposes.push(dispose);
        return dispose;
    }

    /**
     * 定义原生setTimeout
     * @param callback 同原生setTimeout入参
     * @param ms 同原生setTimeout入参
     * @param args 同原生setTimeout入参
     */
    setTimeout(callback: Function, ms: number, ...args) {
        const timer = setTimeout(
            () => {
                callback();
                dispose();
                remove(this.disposes, dispose);
            },
            ms,
            ...args,
        );
        const dispose = Dispose.from(this, () => clearTimeout(timer));
        this.disposes.push(dispose);
        return dispose;
    }

    /**
     * 定义原生setInterval
     * @param callback 同原生setInterval入参
     * @param ms 同原生setInterval入参
     * @param args 同原生setInterval入参
     */
    setInterval(callback: Function, ms: number, ...args) {
        const timer = setInterval(callback, ms, ...args);
        const dispose = Dispose.from(this, () => clearInterval(timer));
        this.disposes.push(dispose);
        return dispose;
    }

    /**
     * 向指定通道发送消息
     * @param channel {import("zhin").Context.MsgChannel} 通道信息
     * @param msg {import("zhin").Element.Fragment} 消息内容
     */
    sendMsg(channel: Context.MsgChannel, msg: Element.Fragment) {
        const { protocol, bot_id, target_id, target_type } = channel;
        return this.zhin.pickBot(protocol, bot_id).sendMsg(target_id, target_type, msg);
    }

    /**
     * 广播一条消息
     * @param channelIds 消息的通道id数组
     * @param content 群发的内容
     */
    broadcast(channelIds: ChannelId | ChannelId[], content: Element.Fragment) {
        channelIds = [].concat(channelIds);
        return Promise.all(
            channelIds
                .map(channelId => {
                    const [protocol, self_id, target_type = protocol, target_id = self_id] =
                        channelId.split(":");
                    const bots: Bot[] = [...this.zhin.adapters.values()].reduce(
                        (result, adapter) => {
                            if (protocol === target_type) result.push(...adapter.bots);
                            else if (protocol === adapter.protocol)
                                result.push(...adapter.bots.filter(bot => bot.self_id === self_id));
                            return result;
                        },
                        [] as Bot[],
                    );
                    return bots.map(bot =>
                        bot.sendMsg(
                            Number(target_id),
                            <"private" | "group" | "discuss" | "guild">target_type,
                            content,
                        ),
                    );
                })
                .flat(),
        );
    }

    /**
     * 同步执行某一event的所有listener
     * @param event 事件名
     * @param args 传递给其listener的参数
     */
    async emitSync(event, ...args) {
        const listeners = this.listeners(event);
        for (const listener of listeners) {
            await listener.apply(this, args);
        }
    }
    /**
     * 执行某一event的所有listener，并获取其返回值
     * @param event 事件名
     * @param args 传递给其listener的参数
     */
    bail(event, ...args) {
        let result;
        const listeners = this.listeners(event);
        for (const listener of listeners) {
            result = listener.apply(this, args);
            if (isBailed(result)) return result;
        }
    }

    /**
     * 同步执行某一event的所有listener，并获取其返回值
     * @param event 事件名
     * @param args 传递给其listener的参数
     */
    async bailSync(event, ...args) {
        let result;
        const listeners = this.listeners(event);
        for (const listener of listeners) {
            result = await listener.apply(this, args);
            if (isBailed(result)) return result;
        }
    }

    /**
     * 销毁指定上下文，如不传入插件，则销毁当前上下文，若传入插件，则销毁指定插件的上下文
     * @param plugin
     */
    dispose(plugin?: Plugin | string) {
        this.emit("before-dispose");
        if (plugin) {
            if (typeof plugin === "string") plugin = this.pluginList.find(p => p.name === plugin);
            if (plugin) {
                plugin.unmount();
                this.plugins.delete(plugin.options.fullName);
            }
            return;
        }
        [...this.plugins.values()].forEach(plugin => {
            plugin.unmount();
            this.plugins.delete(plugin.options.fullName);
        });
        while (this.disposes.length) {
            const dispose = this.disposes.shift();
            try {
                dispose();
            } catch {}
        }
        this.emit("dispose");
        this.emit("after-dispose");
    }

    /**
     * 获得会话匹配的所有可用的组件
     * @param session 会话
     */
    getSupportComponents<P extends keyof Zhin.Adapters>(session: NSession<P>) {
        return this.getMatchedContextList(session).reduce(
            (result: Dict<Component>, context) => {
                Object.assign(result, { ...context.components });
                return result;
            },
            { ...this.components },
        );
    }

    /**
     * 获得会话匹配的所有可用的中间件
     * @param session 会话
     */
    getSupportMiddlewares<P extends keyof Zhin.Adapters>(session: NSession<P>) {
        return this.getMatchedContextList(session)
            .reduce(
                (result: Middleware[], context) => {
                    for (const middleware of context.middlewares) {
                        if (!result.includes(middleware)) result.push(middleware);
                    }
                    return result;
                },
                [...this.middlewares],
            )
            .filter((item, idx, list) => {
                return list.indexOf(item) === idx;
            });
    }

    /**
     * 获得会话匹配的所有可用的指令
     * @param session 会话
     */
    getSupportCommands<P extends keyof Zhin.Adapters>(session: NSession<P>) {
        return this.getMatchedContextList(session)
            .reduce(
                (result: Command[], context) => {
                    result.push(...context.commands.values());
                    return result;
                },
                [...this.commands.values()],
            )
            .filter((item, idx, list) => {
                return list.indexOf(item) === idx;
            }) as Command[];
    }
}

export interface Context extends Zhin.Services {
    [Context.childKey]: Context[];
    [Context.plugin]: Plugin;

    on<T extends keyof Zhin.EventMap<this>>(event: T, listener: Zhin.EventMap<this>[T]);

    on<S extends string | symbol>(
        event: S & Exclude<S, keyof Zhin.EventMap<this>>,
        listener: (...args: any[]) => any,
    );

    emit<T extends keyof Zhin.EventMap<this>>(
        event: T,
        ...args: Parameters<Zhin.EventMap<this>[T]>
    ): boolean;

    emit<S extends string | symbol>(
        event: S & Exclude<S, keyof Zhin.EventMap<this>>,
        ...args: any[]
    ): boolean;

    emitSync<T extends keyof Zhin.EventMap<this>>(
        event: T,
        ...args: Parameters<Zhin.EventMap<this>[T]>
    ): Promise<void>;

    emitSync<S extends string | symbol>(
        event: S & Exclude<S, keyof Zhin.EventMap<this>>,
        ...args: any[]
    ): Promise<void>;

    bail<T extends keyof Zhin.EventMap<this>>(
        event: T,
        ...args: Parameters<Zhin.EventMap<this>[T]>
    ): any;

    bail<S extends string | symbol>(
        event: S & Exclude<S, keyof Zhin.EventMap<this>>,
        ...args: any[]
    ): any;

    bailSync<T extends keyof Zhin.EventMap<this>>(
        event: T,
        ...args: Parameters<Zhin.EventMap<this>[T]>
    ): Promise<any>;

    bailSync<S extends string | symbol>(
        event: S & Exclude<S, keyof Zhin.EventMap<this>>,
        ...args: any[]
    ): Promise<any>;

    component(name: string, component: Component): this;
}

export namespace Context {
    export const plugin = Symbol("plugin");
    export const childKey = Symbol("children");
    export type MsgChannel = {
        protocol: keyof Zhin.Adapters;
        bot_id: string | number;
        target_id: string | number;
        target_type: "private" | "group" | "discuss" | "guild";
    };

    export function from(parent: Context, filter: Filter) {
        const ctx = new Context(parent, filter);
        ctx[plugin] = parent ? parent[plugin] : null;
        return ctx;
    }

    export type Filter = (session: Session) => boolean;
    export const defaultFilter: Filter = () => true;
    export const or = (ctx: Context, filter: Filter) => {
        return ((session: Session) => ctx.filter(session) || filter(session)) as Filter;
    };
    export const not = (ctx: Context, filter: Filter) => {
        return ((session: Session) => ctx.filter(session) && !filter(session)) as Filter;
    };
    export const and = (ctx: Context, filter: Filter) => {
        return ((session: Session) => ctx.filter(session) && filter(session)) as Filter;
    };
}
