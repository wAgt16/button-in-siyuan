import {Dialog, fetchSyncPost, showMessage} from "siyuan";
import {createLogger} from "./logger";
import type {IButtonConfig, TButtonAction} from "./buttonBlock";
import {createButtonElement, parseButtonConfig} from "./buttonBlock";
import type {IContext} from "./context";
import {openButtonBlockEditor} from "./editDialog";
import {isBlockEditable} from "./buttonBlock";
import {openLink} from "./openLink";

const log = createLogger("buttonManager");

/** 一次最多列出多少个按钮块；显式 LIMIT 避免内核按用户设置的搜索条数上限静默截断。 */
const BUTTON_QUERY_LIMIT = 5000;

/** 工作空间里的一个按钮块，外加它所在文档的信息（列表里要显示）。 */
interface IButtonRow {
    id: string;
    config: IButtonConfig;
    rootTitle: string;
    path: string;
}

const actionTypeOf = (config: IButtonConfig) => config.action?.type || "none";

const actionSummary = (context: IContext, config: IButtonConfig) => {
    const {i18n} = context;
    const action: TButtonAction | undefined = config.action;
    if (!action) {
        return i18n.actionNone;
    }
    if (action.type === "link") {
        return `${i18n.actionLink}: ${action.link}`;
    }
    if (action.type === "file") {
        return `${i18n.actionFile}: ${action.file}`;
    }
    const firstLine = action.script.split(/\r?\n/, 1)[0].trim();
    return `${i18n.actionScript}: ${firstLine ? `${firstLine}${action.script.includes("\n") ? " …" : ""}` : i18n.managerInlineScript}`;
};

/**
 * 读取当前工作空间的全部按钮块（issue #28）。
 *
 * 用一条 SQL 同时取块内容、所在文档标题与路径：自定义块的 `content` 就是那段 JSON，`markdown` 是
 * `;;;button-in-siyuan/button` 围栏。所有块都过一遍 `parseButtonConfig`，内容不是本插件配置的块
 * （比如别的插件也用 custom 块）在列表里直接跳过。
 */
const loadRows = async (context: IContext) => {
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT b.id, b.content, b.root_id, b.path, (SELECT content FROM blocks WHERE id = b.root_id) AS root_title ` +
            `FROM blocks b WHERE b.type = 'custom' AND b.markdown LIKE ';;;button-in-siyuan/button%' LIMIT ${BUTTON_QUERY_LIMIT}`,
    }, undefined, false);
    if (response.code !== 0) {
        throw new Error(response.msg || `/api/query/sql code ${response.code}`);
    }
    const rows: IButtonRow[] = [];
    for (const item of (response.data || []) as Array<{
        id?: string;
        content?: string;
        root_title?: string;
        path?: string;
    }>) {
        const config = parseButtonConfig(item.content || "", context.i18n.defaultButtonText);
        if (!item.id || !config) {
            continue;
        }
        rows.push({
            id: item.id,
            config,
            rootTitle: item.root_title || "",
            path: item.path || "",
        });
    }
    rows.sort((a, b) => (a.rootTitle + a.config.text).localeCompare(b.rootTitle + b.config.text));
    log.info("loaded the button blocks for the manager", {rows: rows.length, limit: BUTTON_QUERY_LIMIT});
    return rows;
};

/** 「按钮块管理」窗口的选项。 */
export interface IButtonBlockManagerOptions {
    /**
     * 点「在文档中定位」时先执行。入口在设置面板里，跳转前要把面板一起关掉，
     * 否则文档上还压着设置与管理两层窗口；面板是思源自己的 `Dialog`，由调用方负责关。
     */
    onLocate?: () => void;
}

/**
 * 「按钮块管理」窗口：列出、搜索、预览、编辑当前工作空间的所有按钮块。
 *
 * 入口在插件设置面板里。左侧是列表（按钮外观 + 文本 + 所在文档），右侧是选中项的完整预览、操作
 * 摘要、块 ID 与文档路径，以及「编辑按钮块」「在文档中定位」。编辑复用同一个编辑窗口：块没在
 * 当前窗口渲染时，保存会自动走内核的 `updateBlock`（见 `updateButtonContentAsync`）。
 */
export const openButtonBlockManager = (context: IContext, options: IButtonBlockManagerOptions = {}) => {
    const {i18n} = context;
    const dialog = new Dialog({
        title: i18n.manageButtonBlocks,
        width: context.isMobile ? "100%" : "min(980px, 94vw)",
        height: context.isMobile ? "100%" : "min(82vh, 760px)",
        content: `<div class="b3-dialog__content bis-manager">
    <div class="bis-manager__toolbar">
        <input class="b3-text-field fn__flex-1" data-bis="search" spellcheck="false" placeholder="${i18n.managerSearchPlaceholder}">
        <select class="b3-select" data-bis="action-filter">
            <option value="">${i18n.managerFilterAll}</option>
            <option value="none">${i18n.actionNone}</option>
            <option value="link">${i18n.actionLink}</option>
            <option value="script">${i18n.actionScript}</option>
            <option value="file">${i18n.actionFile}</option>
        </select>
    </div>
    <div class="bis-manager__body">
        <div class="bis-manager__list" data-bis="list"><div class="bis-manager__hint ft__on-surface">${i18n.managerLoading}</div></div>
        <div class="bis-manager__preview" data-bis="preview"><div class="bis-manager__hint ft__on-surface">${i18n.managerSelectHint}</div></div>
    </div>
    <div class="bis-manager__status ft__on-surface ft__smaller" data-bis="status"></div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel" data-bis="close">${i18n.close}</button>
</div>`,
    });
    if (context.isMobile) {
        dialog.element.querySelector(".b3-dialog__container")?.classList.add("bis-dialog-fullscreen");
    }
    const field = <T extends HTMLElement>(type: string) => {
        const element = dialog.element.querySelector<T>(`[data-bis="${type}"]`);
        if (!element) {
            throw new Error(`button-in-siyuan: dialog field [${type}] is missing`);
        }
        return element;
    };
    const searchElement = field<HTMLInputElement>("search");
    const filterElement = field<HTMLSelectElement>("action-filter");
    const listElement = field<HTMLElement>("list");
    const previewElement = field<HTMLElement>("preview");
    const statusElement = field<HTMLElement>("status");
    let rows: IButtonRow[] = [];
    let selectedID = "";

    const matches = (row: IButtonRow) => {
        const filter = filterElement.value;
        if (filter && actionTypeOf(row.config) !== filter) {
            return false;
        }
        const keyword = searchElement.value.trim().toLowerCase();
        if (!keyword) {
            return true;
        }
        const action = row.config.action;
        const target = action?.type === "link"
            ? action.link
            : action?.type === "file"
                ? action.file
                : action?.type === "script"
                    ? action.script.substring(0, 500)
                    : "";
        return [row.config.text, row.config.icon, target, row.rootTitle, row.path, row.id]
            .join("\n")
            .toLowerCase()
            .includes(keyword);
    };

    /** 右侧预览：整颗按钮 + 操作摘要 + 位置信息 + 两个动作。 */
    const showPreview = (row: IButtonRow) => {
        selectedID = row.id;
        // 刷新列表后直接恢复预览时，行高亮也要跟着回来
        listElement.querySelectorAll<HTMLElement>(".bis-manager__row").forEach((element) => {
            element.classList.toggle("bis-manager__row--current", element.dataset.bisId === row.id);
        });
        previewElement.replaceChildren();
        const previewButton = createButtonElement(context, row.config);
        previewButton.classList.add("bis-manager__preview-button");
        previewButton.tabIndex = -1;
        const meta = document.createElement("dl");
        meta.className = "bis-manager__meta";
        const addMeta = (label: string, value: string) => {
            const term = document.createElement("dt");
            term.className = "ft__on-surface ft__smaller";
            term.textContent = label;
            const detail = document.createElement("dd");
            detail.className = "ft__breakword";
            detail.textContent = value;
            meta.append(term, detail);
        };
        addMeta(i18n.managerAction, actionSummary(context, row.config));
        addMeta(i18n.managerDoc, row.rootTitle || "-");
        addMeta(i18n.managerPath, row.path || "-");
        addMeta(i18n.managerBlockID, row.id);
        const actions = document.createElement("div");
        actions.className = "bis-manager__actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "b3-button b3-button--outline";
        edit.textContent = i18n.managerEdit;
        edit.addEventListener("click", () => {
            const blockElement = document.querySelector<HTMLElement>(`[data-type="NodeCustomBlock"][data-node-id="${row.id}"]`);
            openButtonBlockEditor(context, {
                blockID: row.id,
                config: row.config,
                editable: isBlockEditable(blockElement),
                onClosed: () => void reload(),
            });
        });
        const locate = document.createElement("button");
        locate.type = "button";
        locate.className = "b3-button b3-button--text";
        locate.textContent = i18n.managerLocate;
        locate.addEventListener("click", () => {
            log.info("locating a button block in its document", {blockID: row.id});
            // 先把管理窗口与设置面板关掉，再让宿主打开文档、滚动到块并高亮（`siyuan://blocks/<id>`
            // 由宿主的 processSiYuanUri 处理：打开所在文档 + 高亮 + 定位上下文）
            dialog.destroy();
            options.onLocate?.();
            openLink(context, `siyuan://blocks/${row.id}`);
        });
        actions.append(edit, locate);
        previewElement.append(previewButton, meta, actions);
    };

    const renderList = () => {
        const visible = rows.filter(matches);
        listElement.replaceChildren();
        if (!visible.length) {
            const empty = document.createElement("div");
            empty.className = "bis-manager__hint ft__on-surface";
            empty.textContent = i18n.managerEmpty;
            listElement.append(empty);
        }
        visible.forEach((row) => {
            const rowElement = document.createElement("div");
            rowElement.className = "b3-list-item bis-manager__row";
            rowElement.tabIndex = 0;
            rowElement.setAttribute("role", "button");
            rowElement.dataset.bisId = row.id;
            if (row.id === selectedID) {
                rowElement.classList.add("bis-manager__row--current");
            }
            const chip = createButtonElement(context, row.config);
            chip.classList.add("bis-manager__chip");
            chip.tabIndex = -1;
            chip.setAttribute("aria-hidden", "true");
            const text = document.createElement("div");
            text.className = "bis-manager__row-text";
            const title = document.createElement("div");
            title.className = "bis-manager__row-title";
            title.textContent = row.config.text;
            const doc = document.createElement("div");
            doc.className = "bis-manager__row-meta ft__on-surface ft__smaller";
            doc.textContent = row.rootTitle || row.path || row.id;
            text.append(title, doc);
            rowElement.append(chip, text);
            const select = () => {
                listElement.querySelectorAll(".bis-manager__row--current")
                    .forEach((element) => element.classList.remove("bis-manager__row--current"));
                rowElement.classList.add("bis-manager__row--current");
                showPreview(row);
            };
            rowElement.addEventListener("click", select);
            rowElement.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select();
                }
            });
            listElement.append(rowElement);
        });
        statusElement.textContent = `${visible.length} ${i18n.managerCount}`;
        // 选中的块被搜索条件过滤掉时清空右侧，避免显示一个已经不在列表里的项
        if (selectedID && !visible.some((row) => row.id === selectedID)) {
            selectedID = "";
            previewElement.replaceChildren();
            const hint = document.createElement("div");
            hint.className = "bis-manager__hint ft__on-surface";
            hint.textContent = i18n.managerSelectHint;
            previewElement.append(hint);
        }
    };

    const reload = async () => {
        listElement.replaceChildren();
        const loading = document.createElement("div");
        loading.className = "bis-manager__hint ft__on-surface";
        loading.textContent = i18n.managerLoading;
        listElement.append(loading);
        try {
            rows = await loadRows(context);
        } catch (error) {
            log.error("failed to load the button blocks", {error});
            showMessage(i18n.managerLoadFailed);
            rows = [];
        }
        // 刷新后如果原来选中的块还在，保留选中；否则回到空状态
        const previous = rows.find((row) => row.id === selectedID);
        selectedID = "";
        renderList();
        if (previous) {
            showPreview(previous);
        }
    };

    searchElement.addEventListener("input", renderList);
    filterElement.addEventListener("change", renderList);
    field<HTMLButtonElement>("close").addEventListener("click", () => dialog.destroy());
    void reload();
};
