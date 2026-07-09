import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function readRepoFile(...segments: string[]) {
  return fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");
}

test("script asset extraction keeps information content attached to carrier assets", () => {
  const source = readRepoFile("src", "services", "scriptAssetExtraction.ts");
  assert.match(source, /Information content is not a standalone base asset by default/);
  assert.match(source, /Chat records, transfer records, recordings, call logs, notification text and screen contents/);
  assert.match(source, /Phones, computers, recorders, folders and paper vouchers/);
  assert.match(source, /printed chat records, a paper transfer voucher, a labeled audio file stored as evidence/);
});

test("asset foundation backend prompt enforces stable base asset boundaries", () => {
  const source = readRepoFile("src", "services", "assetFoundation.ts");
  assert.match(source, /function assetFoundationBoundaryRules/);
  assert.match(source, /基础资产边界：assetFoundation 只写默认、稳定、可复用事实/);
  assert.match(source, /场景 assetFoundation 只允许写固定布局、常设家具、常设设备、长期陈设/);
  assert.match(source, /手机、电脑、录音笔等载体不得在基础设定中固化具体聊天对象、金额、录音内容/);
  assert.match(source, /资产基础设定边界补充/);
});

test("asset foundation flow skill separates base assets from derived assets and storyboard state", () => {
  const flow = readRepoFile("data", "skills", "asset_foundation_flow.md");
  assert.match(flow, /基础资产、衍生资产与分镜边界/);
  assert.match(flow, /`assetFoundation` 只定义“这个基础资产平时是什么样”/);
  assert.match(flow, /衍生资产用于表达同一资产在某场戏中的状态变化/);
  assert.match(flow, /分镜图 prompt 用于表达具体镜头中的临时摆放、屏幕内容、证据展示和动作关系/);
  assert.match(flow, /餐厅可以写桌椅、收银台、后厨连接、常见调味架/);
  assert.match(flow, /不能写某顿饭的菜碟数量、生日宴菜品、临时账单、冲突证据/);
});

test("asset foundation technique skill forbids temporary scene props and standalone information records", () => {
  const technique = readRepoFile("data", "skills", "asset_foundation_technique.md");
  assert.match(technique, /场景基础设定不承担“这一集发生了什么”/);
  assert.match(technique, /不得写成场景默认物件/);
  assert.match(technique, /聊天记录、转账记录、录音、通话记录、通知文字、屏幕内容等信息内容默认绑定到载体/);
  assert.match(technique, /只有当信息记录已经成为独立实体物件时/);
  assert.match(technique, /这些内容应进入衍生资产或分镜图 prompt/);
});

test("asset foundation review skill blocks episode state and carrier/content boundary violations", () => {
  const review = readRepoFile("data", "skills", "asset_foundation_review.md");
  assert.match(review, /场景 `assetFoundation` 把单集剧情状态、后续事件物件、临时摆放、屏幕内容或证据内容写成默认事实/);
  assert.match(review, /把某场戏临时出现的菜品、账单、手机、纸条、证据、录音、礼物、药品等写成常设物/);
  assert.match(review, /聊天记录、转账记录、录音、通话记录、通知文字、屏幕内容等信息内容作为无载体的独立基础资产/);
  assert.match(review, /打印聊天记录、纸质转账凭证、独立文件、独立物证等已经成为实体物件时/);
});
