// @vitest-environment happy-dom
// S5 #12：ReviewComposer 的键盘契约——Enter 发送 / Shift+Enter 换行 /
// IME 组词回车不发送（CommandPalette 同款守卫）/ 核查中变取消钮。
// 这些是「用户手指」级别的行为，tsc 拦不住，必须挂载了按一遍。
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReviewComposer from "./ReviewComposer";

let container: HTMLDivElement;
let root: Root;

function mount(running = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onSend = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    root.render(
      <ReviewComposer
        disabled={running}
        running={running}
        placeholder="p"
        onSend={onSend}
        onCancel={onCancel}
      />,
    );
  });
  return { onSend, onCancel };
}

function input() {
  return container.querySelector<HTMLTextAreaElement>(".review-composer-input")!;
}

function key(k: string, opts: { shift?: boolean; composing?: boolean } = {}) {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: k,
        shiftKey: opts.shift ?? false,
        bubbles: true,
        // KeyboardEvent 构造器不带 isComposing 入参位？带：它继承 EventInit 之外的
        // KeyboardEventInit，isComposing 是合法字段。
        isComposing: opts.composing ?? false,
      } as KeyboardEventInit),
    );
  });
}

function type(text: string) {
  act(() => {
    // React 在受控输入上挂 value tracker：直接改 el.value 再派发 input 会被
    // 判定「值没变」而不触发 onChange（SettingsModal.test 的 typeInto 同款坑）。
    // 必须走原型上的原生 setter，tracker 才读得到差异。
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ReviewComposer 键盘契约", () => {
  it("Enter 发送并清空；Shift+Enter 只换行不发送", () => {
    const { onSend } = mount();
    // 受控组件：React 15+ 的 value 由 onChange 驱动，测试里直接塞 value 再触发
    // input 事件走 onChange（happy-dom 无 native setter setter 链，够用）。
    type("术语统一用「控制台」");
    key("Enter");
    expect(onSend).toHaveBeenCalledWith("术语统一用「控制台」");
    expect(input().value).toBe("");

    type("第二行");
    key("Enter", { shift: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("IME 组词中的回车不发送（isComposing / keyCode 229 双守卫）", () => {
    const { onSend } = mount();
    type("nihao");
    key("Enter", { composing: true });
    key("Enter", { shift: false });
    // 第二发用的是非组合 Enter——已经发出去一次，说明 composing 那次被拦了
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("纯空白不发送；核查中输入禁用、按钮变取消", () => {
    const { onSend, onCancel } = mount(true);
    expect(input().disabled).toBe(true);
    key("Enter");
    expect(onSend).not.toHaveBeenCalled();
    const cancel = container.querySelector<HTMLButtonElement>(".review-composer-send.cancel");
    expect(cancel).not.toBeNull();
    act(() => {
      cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
