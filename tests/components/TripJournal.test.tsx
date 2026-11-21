import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TripJournal, type JournalDraft } from "@/components/TripJournal";
import { tokyoLocalTrip } from "@/demo/fixtures/tokyo-local";
import * as photos from "@/lib/trip/journal-photo";
import type { JournalEntry } from "@/lib/trip/trip-file";

afterEach(() => vi.restoreAllMocks());

function Journal() {
  const [draft, onDraft] = useState<JournalDraft>({ text: "", place: "" });
  const [notes, setNotes] = useState<JournalEntry[]>([]);
  return (
    <TripJournal
      plan={tokyoLocalTrip()}
      notes={notes}
      arrivals={{}}
      onForgetArrival={() => false}
      draft={draft}
      onDraft={onDraft}
      onSave={(entries) => {
        setNotes(entries);
        return true;
      }}
    />
  );
}

it("处理照片时可继续输入；后选的照片优先，较晚返回的旧任务不能覆盖它", async () => {
  let finishFirst!: (photo: photos.JournalPhoto) => void;
  let finishLast!: (photo: photos.JournalPhoto) => void;
  vi.spyOn(photos, "prepareJournalPhoto")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLast = resolve;
        }),
    );
  render(<Journal />);
  const user = userEvent.setup();
  const input = screen.getByLabelText("添加照片");
  await user.upload(input, new File(["a"], "a.jpg", { type: "image/jpeg" }));
  await user.type(screen.getByLabelText("记下这一刻"), "等图时写下的句子");
  expect(screen.getByRole("button", { name: "保存手记" })).toBeDisabled();
  await user.upload(input, new File(["b"], "b.jpg", { type: "image/jpeg" }));
  const chosen = { src: "data:image/jpeg;base64,/9j/Yg==", width: 40, height: 30 };
  await act(async () => finishLast(chosen));
  await act(async () => finishFirst({ ...chosen, src: "data:image/jpeg;base64,/9j/YQ==" }));
  expect(screen.getByAltText("待保存的手记照片")).toHaveAttribute("src", chosen.src);
  await user.click(screen.getByRole("button", { name: "保存手记" }));
  expect(screen.getByText("等图时写下的句子")).toBeInTheDocument();
  expect(screen.getByAltText("沿途随记的照片")).toHaveAttribute("src", chosen.src);
});

it("遇到不支持的文件时解释原因，仍能保存已输入的文字", async () => {
  const user = userEvent.setup();
  render(<Journal />);
  await user.type(screen.getByLabelText("记下这一刻"), "雨停了");
  fireEvent.change(screen.getByLabelText("添加照片"), {
    target: { files: [new File(["test"], "raw.heic", { type: "image/heic" })] },
  });
  expect(await screen.findByText("请选择 JPG、PNG 或 WebP 照片。")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存手记" }));
  expect(screen.getByText("雨停了")).toBeInTheDocument();
});
