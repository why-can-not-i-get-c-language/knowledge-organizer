import "katex/dist/katex.min.css";
import "./style.css";
import { importBank } from "../domain/quiz.ts";
import { MAX_BANK_BYTES } from "../domain/contracts.ts";
import type { Bank, Question, Anchor } from "../domain/contracts.ts";
import {
  createField,
  paintField,
  anchorForRange,
  anchorForOffsets,
} from "../ui/source-field.ts";
import type { SourceField } from "../ui/source-field.ts";
import { isTauri } from '@tauri-apps/api/core';
import { TauriDeviceServices } from '../platform/tauri-device.ts';
import {
  updateConceptSummary,
  quoteDiscussionText,
} from "../application/concept-summary.ts";
import type {
  ConceptSummary,
  DiscussionQuote,
} from "../application/concept-summary.ts";

// 独立的交互设计状态，不写入正式数据库，不改变v1作答阶段约定。
interface Group {
  id: string;
  name: string;
  parent: string | null;
  open: boolean;
}
interface Card {
  bank: Bank;
  group: string | null;
  round?: Round;
}
interface Answer {
  selected: string[];
  locked: boolean;
  understood: boolean | null;
  marks: Anchor[];
  discussions: Map<Anchor, Discussion>;
}
interface Discussion {
  id: string;
  anchor: Anchor;
  summary: ConceptSummary | null;
  drafts: { id: string; text: string; quote?: DiscussionQuote }[];
  draft: string;
}
interface Round {
  mode: "immediate" | "batch";
  index: number;
  submitted: boolean;
  answers: Answer[];
}
const groups: Group[] = [
  { id: "root", name: "我的学习", parent: null, open: true },
  { id: "term", name: "本学期", parent: "root", open: true },
];
const cards: Card[] = [];
const nativeHost = isTauri();
const nativeDevice = nativeHost ? new TauriDeviceServices() : null;
let current: Card | undefined,
  chosenGroup: string | null = null,
  screen: "library" | "setup" | "quiz" | "results" = "library";
let phone = false,
  drawer = false,
  animating = false;
let fields: SourceField[] = [];
const root = document.querySelector<HTMLElement>("#design")!;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  cls = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = cls;
  return element;
}
function btn(text: string, action: () => void, cls = "") {
  const button = el("button", text, cls);
  button.type = "button";
  button.onclick = action;
  return button;
}
const notice = el("div", "", "notice");
notice.setAttribute("role", "status");
function say(text: string) {
  notice.textContent = text;
}
const studio = el("header", "", "studio");
const brand = el("div");
brand.append(
  el("strong", "知识梳理器"),
  el("span", "交互设计 · 本次预览，不写入学习记录"),
);
const sizes = el("div", "", "segmented");
const desktop = btn("桌面", () => setPhone(false)),
  mobile = btn("手机", () => setPhone(true));
sizes.append(desktop, mobile);
studio.append(brand, sizes);
if (nativeHost) {
  brand.querySelector('span')!.textContent = '新界面体验 · 退出后重置，正式记录请进入本地学习';
  studio.append(btn('本地学习（自动保存）', () => { location.href = '/index.html'; }, 'primary'));
}
const shell = el("div", "", "shell");
const sidebar = el("aside", "", "sidebar");
const backdrop = btn(
  "关闭导航",
  () => {
    drawer = false;
    layout();
  },
  "backdrop",
);
const main = el("main", "", "main");
shell.append(sidebar, backdrop, main);
root.append(studio, shell, notice);
function setPhone(value: boolean) {
  phone = value;
  drawer = false;
  layout();
}
function layout() {
  root.classList.toggle("preview-phone", phone);
  shell.classList.toggle("phone", phone);
  shell.classList.toggle("drawer", drawer);
  desktop.setAttribute("aria-pressed", String(!phone));
  mobile.setAttribute("aria-pressed", String(phone));
}
function trail(id: string | null): string[] {
  const names: string[] = [];
  let node = groups.find((g) => g.id === id);
  while (node) {
    names.unshift(node.name);
    node = groups.find((g) => g.id === node!.parent);
  }
  return names;
}
function under(id: string | null, parent: string): boolean {
  while (id !== null) {
    if (id === parent) return true;
    id = groups.find((g) => g.id === id)?.parent ?? null;
  }
  return false;
}
function groupDialog(group?: Group) {
  const dialog = el("dialog");
  dialog.append(el("h2", group ? "管理分组" : "新建分组"));
  const label = el("label", "名称"),
    input = el("input");
  input.value = group?.name ?? "";
  input.placeholder = "例如：大二上学期";
  input.maxLength = 80;
  label.append(input);
  dialog.append(label);
  const actions = el("div", "", "actions");
  actions.append(
    btn("取消", () => dialog.close()),
    btn(
      group ? "保存名称" : "创建",
      () => {
        if (!input.value.trim()) {
          input.reportValidity();
          input.focus();
          return;
        }
        if (group) group.name = input.value.trim();
        else
          groups.push({
            id: crypto.randomUUID(),
            name: input.value.trim(),
            parent: chosenGroup,
            open: true,
          });
        dialog.close();
        render();
      },
      "primary",
    ),
  );
  if (group)
    actions.append(
      btn("新建子分组", () => {
        chosenGroup = group.id;
        group.open = true;
        dialog.close();
        groupDialog();
      }),
    );
  dialog.append(
    actions,
    el("p", "层级可继续嵌套；名称与学期、课程都可自行安排。", "muted"),
  );
  showDialog(dialog);
  input.required = true;
  input.focus();
}
function showDialog(dialog: HTMLDialogElement) {
  root.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}
function renderSidebar() {
  sidebar.replaceChildren();
  const heading = el("div", "", "side-brand");
  heading.append(el("span", "知", "logo"), el("strong", "知识梳理器"));
  sidebar.append(heading);
  sidebar.append(
    btn(
      "▦  全部套题",
      () => {
        chosenGroup = null;
        screen = "library";
        drawer = false;
        render();
      },
      chosenGroup === null && screen === "library"
        ? "nav-item active"
        : "nav-item",
    ),
  );
  const caption = el("div", "", "side-caption");
  caption.append(
    el("span", "我的分组"),
    btn("＋", () => groupDialog(), "icon-button"),
  );
  sidebar.append(caption);
  function node(group: Group, depth: number) {
    const row = el("div", "", "tree-row");
    row.style.paddingLeft = `${12 + Math.min(depth, 6) * 14}px`;
    const toggle = btn(
      group.open ? "⌄" : "›",
      () => {
        group.open = !group.open;
        renderSidebar();
      },
      "tree-toggle",
    );
    toggle.setAttribute(
      "aria-label",
      `${group.open ? "折叠" : "展开"}${group.name}`,
    );
    toggle.setAttribute("aria-expanded", String(group.open));
    const name = btn(
      group.name,
      () => {
        chosenGroup = group.id;
        screen = "library";
        drawer = false;
        render();
      },
      "tree-name",
    );
    name.title = trail(group.id).join(" / ");
    row.classList.toggle("active", chosenGroup === group.id);
    const manage = btn("⋯", () => groupDialog(group), "icon-button");
    manage.setAttribute("aria-label", `管理${group.name}`);
    row.append(toggle, name, manage);
    sidebar.append(row);
    if (!group.open) return;
    for (const child of groups.filter((g) => g.parent === group.id))
      node(child, depth + 1);
    for (const card of cards.filter((c) => c.group === group.id)) {
      const link = btn(card.bank.title, () => openCard(card), "conversation");
      link.style.marginLeft = `${22 + Math.min(depth, 6) * 14}px`;
      link.classList.toggle(
        "selected",
        current === card && screen !== "library",
      );
      sidebar.append(link);
    }
  }
  groups.filter((g) => g.parent === null).forEach((g) => node(g, 0));
  sidebar.append(
    el("p", "套题像会话一样保留在分组里。\n同一套题可反复练习。", "side-note"),
  );
}
function openCard(card: Card) {
  current = card;
  screen = card.round ? "quiz" : "setup";
  drawer = false;
  render();
}
function top(title: string, subtitle: string) {
  const header = el("header", "", "page-header");
  const left = el("div", "", "header-left");
  const menu = btn(
    "☰",
    () => {
      drawer = !drawer;
      layout();
    },
    "menu icon-button",
  );
  menu.setAttribute("aria-label", "打开分组导航");
  const titles = el("div");
  titles.append(el("p", subtitle, "breadcrumb"), el("h1", title));
  left.append(menu, titles);
  header.append(left);
  main.append(header);
  return header;
}
function render() {
  renderSidebar();
  main.replaceChildren();
  fields = [];
  layout();
  if (screen === "library") library();
  else if (screen === "setup") setup();
  else if (screen === "results") results();
  else quiz();
}
function library() {
  const header = top(
    chosenGroup ? groups.find((g) => g.id === chosenGroup)!.name : "全部套题",
    "学习空间" + (chosenGroup ? " / " + trail(chosenGroup).join(" / ") : ""),
  );
  header.append(btn("＋ 导入套题", pickFile, "primary"));
  const intro = el("section", "", "library-intro");
  intro.append(
    el("span", "LEARNING SPACE", "eyebrow"),
    el("h2", "每一套题，都是一次新的理解。"),
    el("p", "按自己的节奏整理、练习，把没想明白的地方留在原处。", "muted"),
  );
  main.append(intro);
  const tools = el("div", "", "library-tools"),
    search = el("input");
  search.type = "search";
  search.placeholder = "搜索套题名称";
  search.setAttribute("aria-label", "搜索套题");
  tools.append(
    search,
    btn("扫描题集", scanDialog),
    btn("新建分组", () => groupDialog()),
  );
  main.append(tools);
  const list = el("div", "", "bank-list");
  main.append(list);
  function update() {
    list.replaceChildren();
    const visible = cards.filter(
      (c) =>
        (!chosenGroup || under(c.group, chosenGroup)) &&
        c.bank.title.includes(search.value),
    );
    if (!visible.length) {
      list.append(
        el("div", "这里还没有套题。可以导入 JSON，或先新建子分组。", "empty"),
      );
      return;
    }
    for (const card of visible) {
      const row = el("article", "", "bank-card");
      const symbol = el("span", "▤", "bank-symbol");
      const body = el("div", "", "bank-body");
      body.append(
        el("h3", card.bank.title),
        el(
          "p",
          `${card.bank.questions.length} 道题 · ${trail(card.group).join(" / ") || "未分组"}`,
          "muted",
        ),
      );
      const action = btn(
        card.round ? "继续练习 →" : "开始练习 →",
        () => openCard(card),
        "text-button",
      );
      const move = btn("归组", () => moveDialog(card), "text-button");
      row.append(symbol, body, move, action);
      list.append(row);
    }
  }
  search.oninput = update;
  update();
}
function moveDialog(card: Card) {
  const dialog = el("dialog");
  dialog.append(el("h2", "将套题移入分组"));
  const select = el("select");
  const ungrouped = el("option", "未分组");
  ungrouped.value = "";
  select.append(ungrouped);
  for (const group of groups) {
    const option = el("option", trail(group.id).join(" / "));
    option.value = group.id;
    select.append(option);
  }
  select.value = card.group ?? "";
  select.setAttribute("aria-label", "目标分组");
  dialog.append(select);
  const actions = el("div", "", "actions");
  actions.append(
    btn("取消", () => dialog.close()),
    btn(
      "移入分组",
      () => {
        card.group = select.value || null;
        dialog.close();
        render();
      },
      "primary",
    ),
  );
  dialog.append(actions);
  showDialog(dialog);
}
function addBank(bank: Bank) {
  if (
    cards.some((c) => c.bank.id === bank.id && c.bank.version === bank.version)
  )
    return false;
  let group = chosenGroup;
  if (!group) {
    const name = bank.questions[0]!.module;
    let target = groups.find((g) => g.parent === "term" && g.name === name);
    if (!target) {
      target = { id: crypto.randomUUID(), name, parent: "term", open: true };
      groups.push(target);
    }
    group = target.id;
  }
  cards.push({ bank, group });
  return true;
}
function pickFile() {
  if (nativeDevice) {
    void nativeDevice.readImportFile().then(text => {
      if (text === null) return;
      const added = addBank(importBank(text)); render();
      say(added ? '已载入新界面体验，退出后重置；需保存记录请进入“本地学习”。' : '本次预览已有这套题。');
    }).catch(error => say(error instanceof Error ? error.message : '无法读取文件，请重新选择。'));
    return;
  }
  const input = el("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_BANK_BYTES) throw Error("文件超过10MiB");
      const added = addBank(importBank(await file.text()));
      render();
      say(
        added ? "已载入本次预览。正式学习记录未改变。" : "本次预览已有这套题。",
      );
    } catch (error) {
      say(
        error instanceof Error ? error.message : "无法读取文件，请重新选择。",
      );
    }
  };
  input.click();
}
function scanDialog() {
  if (nativeHost) { say('安卓扫描尚未接入。请用“导入套题”从系统文件选择器打开JSON题集。'); return; }
  const dialog = el("dialog");
  dialog.append(
    el("h2", "发现设备中的题集"),
    el(
      "p",
      "支持：JSON 题集（v1，最大10MiB）。此处演示扫描所选文件夹；安卓全盘扫描尚未实现。",
      "muted",
    ),
  );
  const list = el("div", "", "scan-list"),
    status = el("p", "选择一个文件夹后，将检查其中的 JSON 文件。", "muted");
  let found: { bank: Bank; checkbox: HTMLInputElement }[] = [];
  const choose = btn("选择文件夹扫描", () => {
    const input = el("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.multiple = true;
    input.onchange = async () => {
      choose.disabled = true;
      found = [];
      list.replaceChildren();
      const files = [...(input.files ?? [])].filter((f) =>
        /\.json$/i.test(f.name),
      );
      let rejected = 0,
        duplicated = 0;
      const seen = new Set(
        cards.map((c) => JSON.stringify([c.bank.id, c.bank.version])),
      );
      for (let i = 0; i < files.length; i++) {
        status.textContent = `正在检查 ${i + 1} / ${files.length}…`;
        const file = files[i]!;
        try {
          if (file.size > MAX_BANK_BYTES) throw Error();
          const bank = importBank(await file.text());
          const key = JSON.stringify([bank.id, bank.version]);
          if (seen.has(key)) {
            duplicated++;
            continue;
          }
          seen.add(key);
          const label = el("label", "", "scan-item"),
            checkbox = el("input");
          checkbox.type = "checkbox";
          checkbox.checked = true;
          const text = el("span");
          text.append(
            el("strong", bank.title),
            el("small", file.webkitRelativePath || file.name),
          );
          label.append(checkbox, text);
          list.append(label);
          found.push({ bank, checkbox });
        } catch {
          rejected++;
        }
      }
      status.textContent = `找到 ${found.length} 套可导入题集 · ${duplicated} 个重复 · ${rejected} 个格式不符或过大`;
      choose.disabled = false;
    };
    input.click();
  });
  const actions = el("div", "", "actions");
  actions.append(
    btn("关闭", () => dialog.close()),
    btn(
      "导入勾选题集",
      () => {
        let count = 0;
        for (const item of found)
          if (item.checkbox.checked && addBank(item.bank)) count++;
        if (!count) {
          status.textContent = "请先扫描并勾选尚未导入的题集。";
          return;
        }
        dialog.close();
        render();
        say(`已载入 ${count} 套题，仅用于本次预览。`);
      },
      "primary",
    ),
  );
  dialog.append(choose, status, list, actions);
  showDialog(dialog);
}
function setup() {
  const card = current!;
  top(card.bank.title, trail(card.group).join(" / "));
  const body = el("section", "", "setup");
  body.append(
    btn(
      "← 返回套题列表",
      () => {
        screen = "library";
        render();
      },
      "text-button",
    ),
    el(
      "span",
      `${card.bank.questions.length} 道题 · 可随时切换题号`,
      "eyebrow",
    ),
    el("h2", "这次，想怎样练习？"),
    el("p", "为这一轮选择反馈方式。练习开始后保持当前模式。", "muted"),
  );
  let mode: Round["mode"] = "immediate";
  const modes = el("div", "", "modes");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "答题反馈模式");
  const immediate = btn(
    "",
    () => {
      mode = "immediate";
      refresh();
    },
    "mode-card",
  );
  immediate.append(
    el("span", "01", "mode-number"),
    el("h3", "逐题反馈"),
    el("p", "确认一题，解开一题。\n原页查看解析，再标记理解程度。"),
  );
  const batch = btn(
    "",
    () => {
      mode = "batch";
      refresh();
    },
    "mode-card",
  );
  batch.append(
    el("span", "02", "mode-number"),
    el("h3", "整套提交"),
    el("p", "专心完成整套题。\n统一提交后，再逐题查看解析。"),
  );
  function refresh() {
    immediate.setAttribute("aria-pressed", String(mode === "immediate"));
    batch.setAttribute("aria-pressed", String(mode === "batch"));
  }
  refresh();
  modes.append(immediate, batch);
  body.append(
    modes,
    btn(
      "开始这一轮 →",
      () => {
        card.round = {
          mode,
          index: 0,
          submitted: false,
          answers: card.bank.questions.map(() => ({
            selected: [],
            locked: false,
            understood: null,
            marks: [],
            discussions: new Map(),
          })),
        };
        screen = "quiz";
        render();
      },
      "primary start",
    ),
  );
  main.append(body);
}
function textField(
  question: Question,
  source: string,
  field: Anchor["field"],
  answer: Answer,
  optionId?: string,
) {
  const data = createField(source, {
    questionId: question.id,
    field,
    ...(optionId ? { optionId } : {}),
  });
  paintField(data, answer.marks, (start, end) =>
    addMark(anchorForOffsets(current!.bank, data, start, end), answer),
  );
  fields.push(data);
  data.element.addEventListener("click", (event) => {
    if (
      !(event.target as Element).closest(".highlight") ||
      window.getSelection()?.toString()
    )
      return;
    const range = document.createRange();
    range.selectNodeContents(event.target as Node);
    const hit = anchorForRange(current!.bank, data, range);
    const anchor = answer.marks.find(
      (a) =>
        a.field === field &&
        a.optionId === optionId &&
        a.start < hit.end &&
        a.end > hit.start,
    );
    if (anchor) openDiscussion(answer, anchor);
  });
  return data.element;
}
function addMark(anchor: Anchor, answer: Answer) {
  if (
    !answer.marks.some(
      (a) =>
        a.field === anchor.field &&
        a.optionId === anchor.optionId &&
        a.start === anchor.start &&
        a.end === anchor.end,
    )
  )
    answer.marks.push(anchor);
  window.getSelection()?.removeAllRanges();
  render();
  const saved = answer.marks.find(
    (a) =>
      a.field === anchor.field &&
      a.optionId === anchor.optionId &&
      a.start === anchor.start &&
      a.end === anchor.end,
  )!;
  openDiscussion(answer, saved);
  say("可填写概括或准备提问。当前未连接DeepSeek，不会发送请求。");
}
function equal(a: string[], b: string[]) {
  return a.length === b.length && a.every((id) => b.includes(id));
}
function questionPage(index: number) {
  const round = current!.round!,
    question = current!.bank.questions[index]!,
    answer = round.answers[index]!;
  const page = el("article", "", "question-page");
  page.dataset.index = String(index);
  const types = { boolean: "判断题", single: "单项选择", multiple: "多项选择" };
  const meta = el("div", "", "question-meta");
  meta.append(
    el("span", types[question.type], "badge"),
    el("span", question.module, "muted"),
  );
  page.append(meta);
  page.append(textField(question, question.prompt, "prompt", answer));
  const options = el("div", "", "options");
  question.options.forEach((option, at) => {
    const row = el("div", "", "option");
    row.classList.toggle("checked", answer.selected.includes(option.id));
    const choose = btn(
      String.fromCharCode(65 + at),
      () => {
        if (window.getSelection()?.toString()) {
          say("请先标记或取消选文，再选择答案。");
          return;
        }
        if (answer.locked) return;
        answer.selected =
          question.type === "multiple"
            ? answer.selected.includes(option.id)
              ? answer.selected.filter((id) => id !== option.id)
              : [...answer.selected, option.id]
            : [option.id];
        render();
      },
      "option-button",
    );
    choose.disabled = answer.locked;
    choose.setAttribute(
      "aria-label",
      `选择选项${String.fromCharCode(65 + at)}`,
    );
    choose.setAttribute(
      "aria-pressed",
      String(answer.selected.includes(option.id)),
    );
    row.append(
      choose,
      textField(question, option.text, "option", answer, option.id),
    );
    options.append(row);
  });
  page.append(options);
  if (!answer.locked && round.mode === "immediate") {
    const confirm = btn(
      "确认本题，查看解析",
      () => {
        if (!answer.selected.length || window.getSelection()?.toString())
          return;
        answer.locked = true;
        render();
      },
      "primary confirm",
    );
    confirm.disabled = !answer.selected.length;
    page.append(confirm);
  }
  if (answer.locked) {
    const review = el("section", "", "review");
    const correct = equal(answer.selected, question.correctAnswer);
    review.append(
      el(
        "strong",
        correct ? "✓ 回答正确" : "再看一遍这个知识点",
        correct ? "correct" : "incorrect",
      ),
    );
    review.append(
      el(
        "p",
        "正确答案：" +
          question.correctAnswer
            .map((id) =>
              String.fromCharCode(
                65 + question.options.findIndex((o) => o.id === id),
              ),
            )
            .join("、"),
      ),
      textField(question, question.explanation, "explanation", answer),
    );
    const self = el("div", "", "self-assessment");
    self.append(el("span", "读完解析，我现在："));
    for (const [value, label] of [
      [true, "理解了"],
      [false, "仍不理解"],
    ] as const) {
      const button = btn(label, () => {
        answer.understood = value;
        render();
      });
      button.setAttribute("aria-pressed", String(answer.understood === value));
      self.append(button);
    }
    review.append(self);
    page.append(review);
  }
  const mark = btn(
    "＋ 标记选中的疑问",
    () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.toString()) {
        say("先在题干、选项或解析中拖选文字，公式可点“标记整式”。");
        return;
      }
      try {
        const range = selection.getRangeAt(0);
        const field = fields.find(
          (f) =>
            f.element.contains(range.startContainer) &&
            f.element.contains(range.endContainer),
        );
        if (!field) throw Error("请在同一段题干、选项或解析内选文。");
        addMark(anchorForRange(current!.bank, field, range), answer);
      } catch (error) {
        say(
          error instanceof Error ? error.message : "选区无法定位，请重新选择。",
        );
      }
    },
    "text-button mark",
  );
  mark.onmousedown = (e) => e.preventDefault();
  page.append(mark);
  for (const anchor of answer.marks) {
    const discussion = answer.discussions.get(anchor);
    const note = btn("", () => openDiscussion(answer, anchor), "concept-link");
    note.append(
      el(
        "strong",
        discussion?.drafts.length
          ? "◉ 已准备提问"
          : discussion?.summary
            ? "◈ 已有概括"
            : "◇ 局部疑问",
      ),
      el("span", anchor.quote),
      el("small", discussion?.summary?.text || "点开查看概括与讨论 →"),
    );
    page.append(note);
  }
  return page;
}

function openDiscussion(answer: Answer, anchor: Anchor) {
  let discussion = answer.discussions.get(anchor);
  if (!discussion) {
    discussion = {
      id: crypto.randomUUID(),
      anchor,
      summary: null,
      drafts: [],
      draft: "",
    };
    answer.discussions.set(anchor, discussion);
  }
  const item = discussion;
  const dialog = el("dialog", "", "discussion-panel");
  const heading = el("div", "", "discussion-heading");
  heading.append(
    el("h2", "这个概念"),
    btn("关闭", () => dialog.close(), "text-button"),
  );
  dialog.append(
    heading,
    el("p", "交互预览 · DeepSeek尚未连接 · 刷新会重置", "connection-state"),
    el("blockquote", anchor.quote, "doubt"),
  );
  const body = el("div", "", "discussion-body");
  dialog.append(body);
  const feedback = el("p", "", "muted");
  feedback.setAttribute("role", "status");
  dialog.append(feedback);
  let view: "summary" | "chat" = "summary";
  let selection: DiscussionQuote | undefined;
  function capture(
    element: HTMLElement,
    sourceId: string,
    revision: number,
    source: string,
  ) {
    const selected = window.getSelection();
    if (!selected?.rangeCount || !selected.toString()) return;
    const range = selected.getRangeAt(0);
    if (
      !element.contains(range.startContainer) ||
      !element.contains(range.endContainer)
    )
      return;
    const before = document.createRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    const through = document.createRange();
    through.selectNodeContents(element);
    through.setEnd(range.endContainer, range.endOffset);
    selection = quoteDiscussionText(
      sourceId,
      revision,
      source,
      before.toString().length,
      through.toString().length,
    );
    feedback.textContent = `已选中“${selection.quote}”，可点“就选文继续问”。`;
  }
  function selectable(text: string, id: string, revision: number) {
    const element = el("div", text, "discussion-text");
    element.addEventListener("pointerup", () =>
      capture(element, id, revision, text),
    );
    element.addEventListener("keyup", () =>
      capture(element, id, revision, text),
    );
    return element;
  }
  function draw() {
    body.replaceChildren();
    if (view === "summary") {
      body.append(el("h3", "概念概括"));
      if (item.summary)
        body.append(
          selectable(
            item.summary.text,
            item.id + ":summary",
            item.summary.revision,
          ),
        );
      else
        body.append(
          el(
            "p",
            "还没有概括。你可以写一句自己的理解，之后也可让AI提出概括候选。",
            "muted",
          ),
        );
      const label = el("label", "编辑概括"),
        editor = el("textarea");
      editor.value = item.summary?.text ?? "";
      editor.maxLength = 20000;
      editor.rows = 5;
      label.append(editor);
      body.append(label);
      const expected = item.summary?.revision ?? null;
      const actions = el("div", "", "actions");
      actions.append(
        btn(
          "保存概括",
          () => {
            try {
              item.summary = updateConceptSummary(
                item.summary,
                { text: editor.value, author: "user" },
                expected,
                new Date().toISOString(),
              );
              feedback.textContent = "概括已保留在本次预览中。";
              draw();
            } catch (error) {
              feedback.textContent =
                error instanceof Error ? error.message : "概括无法保存";
            }
          },
          "primary",
        ),
      );
      const summarize = btn("让AI概括", () => {});
      summarize.disabled = true;
      summarize.title = "真实DeepSeek接通后启用";
      actions.append(
        summarize,
        btn("继续问 →", () => {
          view = "chat";
          selection = undefined;
          draw();
        }),
        btn("就选文继续问", () => {
          if (!selection) {
            feedback.textContent = "先在上面的概括中选择一段文字。";
            return;
          }
          view = "chat";
          draw();
        }),
      );
      body.append(
        actions,
        el(
          "p",
          "点击原文标记会先回到这里。概括与完整讨论分别保留，概括不会改写题目答案。",
          "muted",
        ),
      );
    } else {
      body.append(
        btn(
          "← 查看概括",
          () => {
            view = "summary";
            selection = undefined;
            draw();
          },
          "text-button",
        ),
        el("h3", "本处讨论"),
      );
      if (!item.drafts.length)
        body.append(
          el("p", "尚未发送问题。这里将显示真实回答和追问历史。", "muted"),
        );
      for (const draft of item.drafts) {
        const message = el("article", "", "discussion-message");
        message.append(el("small", "我的提问草稿 · 未发送"));
        if (draft.quote)
          message.append(el("blockquote", draft.quote.quote, "doubt"));
        message.append(selectable(draft.text, draft.id, 0));
        body.append(message);
      }
      const quoted = el(
        "blockquote",
        selection
          ? `针对选文：${selection.quote}`
          : "提问背景：本题与上方标记片段",
        "doubt",
      );
      body.append(quoted);
      const label = el("label", "继续提问"),
        input = el("textarea");
      input.rows = 4;
      input.value = item.draft;
      input.maxLength = 20000;
      input.placeholder = "不用先组织术语，直接说哪里没想明白…";
      input.oninput = () => {
        item.draft = input.value;
      };
      label.append(input);
      body.append(label);
      const actions = el("div", "", "actions");
      actions.append(
        btn("就选文继续问", () => {
          if (!selection) {
            feedback.textContent = "先在之前的文字中拖选一段内容。";
            return;
          }
          quoted.textContent = `针对选文：${selection.quote}`;
          input.focus();
        }),
        btn(
          "保留提问草稿",
          () => {
            if (!input.value.trim()) {
              feedback.textContent = "请先输入问题。";
              return;
            }
            item.drafts.push({
              id: crypto.randomUUID(),
              text: input.value.trim(),
              ...(selection ? { quote: selection } : {}),
            });
            item.draft = "";
            selection = undefined;
            feedback.textContent = "仅保留草稿，尚未向DeepSeek发送。";
            draw();
          },
          "primary",
        ),
      );
      const send = btn("发送给DeepSeek", () => {});
      send.disabled = true;
      send.title = "尚未接通API";
      actions.append(send);
      body.append(actions);
    }
  }
  dialog.addEventListener("close", () => render(), { once: true });
  draw();
  showDialog(dialog);
}
function quiz() {
  const card = current!,
    round = card.round!;
  const header = top(
    card.bank.title,
    `${round.mode === "immediate" ? "逐题反馈" : "整套提交"} · 练习预览`,
  );
  header.append(
    btn(
      "返回题库",
      () => {
        screen = "library";
        render();
      },
      "text-button",
    ),
  );
  const progress = el("div", "", "progress");
  const bar = el("div");
  bar.style.width = `${((round.index + 1) / round.answers.length) * 100}%`;
  progress.append(bar);
  main.append(progress);
  const counter = el("div", "", "question-counter");
  counter.append(
    el("span", `第 ${round.index + 1} 题`, "counter-current"),
    el("span", `/ ${round.answers.length}`, "muted"),
    btn("题号导航 ▦", numberDialog, "text-button"),
  );
  main.append(counter);
  const viewport = el("div", "", "question-viewport"),
    track = el("div", "", "question-track");
  // 只保留当前页和相邻页；手势结束后平移已渲染内容，不重新加载页面。
  const left =
    round.index > 0
      ? questionPage(round.index - 1)
      : el("article", "", "question-page");
  const active = questionPage(round.index);
  const right =
    round.index + 1 < round.answers.length
      ? questionPage(round.index + 1)
      : el("article", "", "question-page");
  left.inert = right.inert = true;
  left.setAttribute("aria-hidden", "true");
  right.setAttribute("aria-hidden", "true");
  track.append(left, active, right);
  viewport.append(track);
  main.append(viewport);
  const resize = new ResizeObserver(() => {
    if (!viewport.isConnected) {
      resize.disconnect();
      return;
    }
    viewport.style.height = `${active.offsetHeight}px`;
  });
  resize.observe(active);
  const footer = el("footer", "", "question-footer");
  const previous = btn("← 上一题", () => navigate(-1));
  previous.disabled = round.index === 0;
  const next = btn(
    round.index === round.answers.length - 1
      ? round.submitted || round.mode === "immediate"
        ? "查看本轮结果"
        : "提交整套答案"
      : "下一题 →",
    () => (round.index === round.answers.length - 1 ? finish() : navigate(1)),
    "primary",
  );
  footer.append(previous, el("span", "左右滑动切题", "muted swipe-hint"), next);
  main.append(footer);
  let start: { x: number; y: number; at: number } | undefined;
  viewport.addEventListener("pointerdown", (event) => {
    if (
      event.pointerType !== "touch" ||
      (event.target as Element).closest("button,input,textarea") ||
      window.getSelection()?.toString()
    )
      return;
    start = { x: event.clientX, y: event.clientY, at: performance.now() };
  });
  viewport.addEventListener("pointerup", (event) => {
    if (!start) return;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y,
      elapsed = performance.now() - start.at;
    start = undefined;
    if (
      elapsed < 300 &&
      Math.abs(dx) > 55 &&
      Math.abs(dx) > Math.abs(dy) * 1.6 &&
      !window.getSelection()?.toString()
    )
      navigate(dx < 0 ? 1 : -1);
  });
  viewport.addEventListener("pointercancel", () => {
    start = undefined;
  });
}
function navigate(delta: number) {
  if (animating || window.getSelection()?.toString()) return;
  const round = current!.round!,
    index = round.index + delta;
  if (index < 0 || index >= round.answers.length) return;
  const track = main.querySelector<HTMLElement>(".question-track")!;
  animating = true;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  track.style.transition = reduced
    ? "none"
    : "transform 190ms cubic-bezier(.2,.7,.3,1)";
  track.style.transform = `translateX(${-100 - delta * 100}%)`;
  setTimeout(
    () => {
      round.index = index;
      animating = false;
      render();
    },
    reduced ? 0 : 195,
  );
}
function numberDialog() {
  const dialog = el("dialog");
  dialog.append(
    el("h2", "题号导航"),
    el("p", "空白：未答 · 绿色：已选 · 实心：已锁定", "muted"),
  );
  const grid = el("div", "", "number-grid");
  current!.round!.answers.forEach((answer, i) => {
    const button = btn(
      String(i + 1),
      () => {
        current!.round!.index = i;
        dialog.close();
        render();
      },
      answer.locked ? "locked" : answer.selected.length ? "answered" : "",
    );
    button.setAttribute("aria-label", `跳到第${i + 1}题`);
    grid.append(button);
  });
  dialog.append(
    grid,
    btn("关闭", () => dialog.close()),
  );
  showDialog(dialog);
}
function finish() {
  const round = current!.round!;
  const missing = round.answers.flatMap((a, i) =>
    !a.selected.length || (round.mode === "immediate" && !a.locked)
      ? [i + 1]
      : [],
  );
  if (missing.length) {
    say(
      `请先完成第 ${missing.slice(0, 20).join("、")} 题${missing.length > 20 ? "等" : ""}，再查看结果。`,
    );
    numberDialog();
    return;
  }
  if (round.mode === "batch" && !round.submitted) {
    const dialog = el("dialog");
    dialog.append(
      el("h2", "提交整套答案？"),
      el("p", "提交后本轮答案锁定，再逐题查看解析与填写理解评价。"),
    );
    const actions = el("div", "", "actions");
    actions.append(
      btn("继续检查", () => dialog.close()),
      btn(
        "确认提交",
        () => {
          round.submitted = true;
          round.answers.forEach((a) => {
            a.locked = true;
          });
          round.index = 0;
          dialog.close();
          render();
          say("已展示解析，请逐题填写理解评价。");
        },
        "primary",
      ),
    );
    dialog.append(actions);
    showDialog(dialog);
    return;
  }
  screen = "results";
  render();
}
function results() {
  const card = current!,
    round = card.round!;
  top("这一轮，理解了多少？", card.bank.title);
  const section = el("section", "", "results");
  const correct = round.answers.filter((a, i) =>
    equal(a.selected, card.bank.questions[i]!.correctAnswer),
  ).length;
  section.append(
    el("span", "练习结果 · 交互预览", "eyebrow"),
    el("h2", `${correct} / ${round.answers.length}`),
    el(
      "p",
      `答对题数 · ${round.answers.filter((a) => a.understood === true).length} 题理解了 · ${round.answers.filter((a) => a.understood === null).length} 题待评价`,
      "muted",
    ),
  );
  round.answers.forEach((a, i) =>
    section.append(
      btn(
        `第 ${i + 1} 题　${equal(a.selected, card.bank.questions[i]!.correctAnswer) ? "答对" : "答错"} · ${a.understood === null ? "待评价" : a.understood ? "理解了" : "仍不理解"}${a.marks.length ? ` · ${a.marks.length} 处疑问` : ""}`,
        () => {
          round.index = i;
          screen = "quiz";
          render();
        },
        "result-row",
      ),
    ),
  );
  section.append(
    btn("返回题库", () => {
      screen = "library";
      render();
    }),
    btn(
      "重新体验模式选择",
      () => {
        screen = "setup";
        render();
      },
      "primary",
    ),
  );
  main.append(section);
}
document.addEventListener("keydown", (event) => {
  if (
    screen !== "quiz" ||
    document.querySelector("dialog[open]") ||
    (event.target as Element).closest("input,textarea,select,button") ||
    window.getSelection()?.toString()
  )
    return;
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    navigate(event.key === "ArrowRight" ? 1 : -1);
  }
});
render();
try {
  const response = nativeHost ? null : await fetch("/design-bank.json");
  if (response?.ok && response.status !== 204) {
    addBank(importBank(await response.text()));
    render();
    say("已载入本地练习文件。可以开始体验，也可导入自己的 JSON。");
  }
} catch {
  say("可从“导入套题”载入 JSON 开始体验。");
}
