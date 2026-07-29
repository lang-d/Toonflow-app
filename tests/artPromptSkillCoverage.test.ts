import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getArtPrompt } from "../src/utils/getArtPrompt";

const artRoot = path.join(process.cwd(), "data", "skills", "art_skills");
const referencePackage = "realpeople_urban_modern";
const upgradedPackages = [
  "2D_90s_japanese_anime",
  "2D_chinese_guofeng",
  "2D_flat_design",
  "2D_mature_urban_romance",
  "3D_anime_render",
  "3D_chinese_traditional",
  "3D_clay_stopmotion",
  "3D_guofeng_cyber",
  "realpeople_ancient_chinese",
  "realpeople_modern_city",
  "realpeople_island_survival",
] as const;
const newPackages = [
  "realpeople_republican_period",
  "realpeople_professional_documentary",
  "realpeople_sports_cinematic",
  "realpeople_rural_naturalism",
] as const;
const manuals = [
  "art_character",
  "art_character_derivative",
  "art_scene",
  "art_scene_derivative",
  "art_prop",
  "art_prop_derivative",
] as const;

const styleRequirements: Record<(typeof upgradedPackages)[number], RegExp[]> = {
  realpeople_island_survival: [/真人荒岛求生/, /真实/, /不得新增|不新增/],
  "2D_90s_japanese_anime": [/90年代手绘日式动画/, /赛璐璐平涂/, /胶片颗粒/],
  "2D_chinese_guofeng": [/水墨线韵/, /卷轴式空间/, /传统色/],
  "2D_flat_design": [/几何轮廓/, /有限色板/, /色块遮挡/],
  "2D_mature_urban_romance": [/成熟人物比例/, /都市色盘/, /动机光/],
  "3D_anime_render": [/卡通着色/, /角色绑定/, /PBR塑料/],
  "3D_chinese_traditional": [/礼制结构/, /克制PBR材质/, /传统建筑/],
  "3D_clay_stopmotion": [/黏土颗粒/, /指纹/, /逐格制作感/],
  "3D_guofeng_cyber": [/传统结构为主体/, /实体PBR材质与发光材质分区/, /霓虹满屏/],
  "realpeople_ancient_chinese": [/真人中国古风实拍摄影/, /自然织物褶皱/, /自然天光/],
  "realpeople_modern_city": [/真人现代都市实拍摄影/, /真实面孔与皮肤纹理/, /动机光/],
};

const referenceHashes: Record<(typeof manuals)[number], string> = {
  art_character: "d3f6ccfa493644a7893b9d053f108365274fca8c379ef1ad1b11116157f81a24",
  art_character_derivative: "44c972ba4e40e180aef7fcb66e49905d333b1df817eddd260a6e777f043d4907",
  art_scene: "961285f07de3517ea640f725eff5bb277ac20ec3af2a362dcc624f95432b8dfc",
  art_scene_derivative: "00d786dc9d2149e56ec2daa73d4484fea0fddaf683fb07e1c9bf3c42aaed0c50",
  art_prop: "9b2115c42f017334d0f4cbee3e45a004961e7f6649c8c9621bc68bb0c74bad58",
  art_prop_derivative: "0c1cdea416f551dcfcf16c4ac2b49fd4bbd0e1608797614bbfc4544169396b6a",
};

function manualPath(packageName: string, manual: string) {
  return path.join(artRoot, packageName, "art_prompt", `${manual}.md`);
}

function readManual(packageName: string, manual: string) {
  return fs.readFileSync(manualPath(packageName, manual), "utf8").replace(/\r\n/g, "\n");
}

function sha256(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("all 102 active Art manuals resolve through the real Art loader", () => {
  const packages = fs.readdirSync(artRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.equal(packages.length, 17);

  for (const packageName of packages) {
    for (const manual of manuals) {
      const content = getArtPrompt(packageName, "art_skills", manual).replace(/\r\n/g, "\n");
      assert.ok(content.length > 200, `${packageName}/${manual}`);
      if (packageName !== referencePackage) {
        assert.match(content, new RegExp(`^---\\nname: ${manual}$`, "m"), `${packageName}/${manual}`);
      }
    }
  }
});

test("the 24 new visual Art manuals keep facts, rationale and ordered asset-specific templates", () => {
  const styleVocabulary: Record<(typeof newPackages)[number], RegExp[]> = {
    realpeople_republican_period: [/真人民国年代写实/, /年代/, /禁止项/],
    realpeople_professional_documentary: [/真人专业纪实写实/, /确认/, /权限|职业/],
    realpeople_sports_cinematic: [/真人体育竞技写实/, /确认/, /运动|场地|项目/],
    realpeople_rural_naturalism: [/真人乡土自然写实/, /确认/, /地域|生活/],
  };
  const manualIdentity: Record<(typeof manuals)[number], RegExp[]> = {
    art_character: [/基础设定图/, /稳定事实/],
    art_character_derivative: [/same person as reference image/, /本次唯一变化/],
    art_scene: [/environment design sheet/, /稳定事实/],
    art_scene_derivative: [/same location/, /本次唯一变化/],
    art_prop: [/prop design sheet/, /稳定事实/],
    art_prop_derivative: [/same object/, /本次唯一变化/],
  };

  for (const packageName of newPackages) {
    for (const manual of manuals) {
      const content = readManual(packageName, manual);
      assert.match(content, /assetFoundation/, `${packageName}/${manual}`);
      assert.match(content, /visualDesignRationale/, `${packageName}/${manual}`);
      assert.match(content, /## 职责与方法/, `${packageName}/${manual}`);
      assert.match(content, /## 类型专属设计方法/, `${packageName}/${manual}`);
      assert.match(content, /## 提示词模板（编译顺序）/, `${packageName}/${manual}`);
      assert.match(content, /## 输出规则/, `${packageName}/${manual}`);
      assert.match(content, /## 必守与严禁/, `${packageName}/${manual}`);
      assert.match(content, /<assetImagePrompt>/, `${packageName}/${manual}`);
      assert.equal((content.match(/```text\n/g) || []).length, 1, `${packageName}/${manual}`);
      assert.doesNotMatch(content, /Seedance|@reference|\bCFG\b|--ar\b|https?:\/\//i);
      for (const requirement of styleVocabulary[packageName]) assert.match(content, requirement, `${packageName}/${manual}`);
      for (const requirement of manualIdentity[manual]) assert.match(content, requirement, `${packageName}/${manual}`);

      const template = content.match(/```text\n([\s\S]+?)\n```/)?.[1];
      assert.ok(template, `${packageName}/${manual}`);
      const ordered = ["稳定事实：", "设计理由：", "专业细节：", "视图与构图：", "光线材质：", "背景：", "禁止项："];
      let previous = -1;
      for (const marker of ordered) {
        const current = template.indexOf(marker);
        assert.ok(current > previous, `${packageName}/${manual}: ${marker}`);
        previous = current;
      }
    }
  }
});

test("each of the 24 new Art manuals contains its asset-specific professional method group", () => {
  const packageMethods: Record<(typeof newPackages)[number], Record<(typeof manuals)[number], RegExp[]>> = {
    realpeople_republican_period: {
      art_character: [/骨相/, /领口.*门襟.*袖型/, /正侧背|四视图/],
      art_character_derivative: [/雨湿/, /灰尘/, /伤病/, /唯一变化/],
      art_scene: [/街巷/, /车站/, /住宅/, /办公/, /稳定地标/],
      art_scene_derivative: [/视角或景别/, /时段变化/, /天气变化/, /两个既有地标/],
      art_prop: [/木作/, /铸造/, /冲压/, /纸张/, /皮革/, /玻璃/],
      art_prop_derivative: [/纤维/, /木材/, /金属/, /玻璃/, /织物和皮革/],
    },
    realpeople_professional_documentary: {
      art_character: [/服装.*贴身层/, /证件/, /防护用品/, /权限/],
      art_character_derivative: [/制服层/, /防护层/, /证件/, /升级职位权限/],
      art_scene: [/办公空间/, /诊疗空间/, /司法空间/, /调查现场/, /隐私遮挡/],
      art_scene_derivative: [/区域开放/, /设备状态/, /玻璃反射/, /隐私遮挡/],
      art_prop: [/文件类/, /证物类/, /医疗设备/, /电子设备/, /普通工具/],
      art_prop_derivative: [/开合/, /启停/, /显示状态/, /封装/, /污染/, /损坏/],
    },
    realpeople_sports_cinematic: {
      art_character: [/身体比例/, /弹性方向/, /鞋履/, /护具/, /不由项目.*推导肌肉/],
      art_character_derivative: [/赛后状态/, /汗湿/, /泥污/, /伤病/, /唯一变化/],
      art_scene: [/场地\/球场/, /跑道/, /水域/, /规则空间/, /频闪/],
      art_scene_derivative: [/规则几何/, /表面状态/, /比赛方向/, /两处既有标线/],
      art_prop: [/重心/, /接触面/, /弹性/, /接缝/, /护具/],
      art_prop_derivative: [/充放气/, /湿润/, /泥污/, /磨损/, /损坏/],
    },
    realpeople_rural_naturalism: {
      art_character: [/骨相/, /服装.*贴身层/, /鞋履/, /不.*晒黑/],
      art_character_derivative: [/雨湿/, /泥尘/, /汗湿/, /磨损/, /伤病/],
      art_scene: [/村居与院落/, /道路/, /田地与水域/, /作坊/, /集市/],
      art_scene_derivative: [/时段\/天气/, /季节/, /地点状态/, /两个既有建筑/],
      art_prop: [/木、竹、藤/, /金属/, /陶瓷/, /玻璃/, /塑料/, /织物/],
      art_prop_derivative: [/湿润/, /泥尘/, /磨损/, /修补/, /缺损/],
    },
  };

  for (const packageName of newPackages) {
    for (const manual of manuals) {
      const content = getArtPrompt(packageName, "art_skills", manual).replace(/\r\n/g, "\n");
      for (const method of packageMethods[packageName][manual]) {
        assert.match(content, method, `${packageName}/${manual}`);
      }
      if (manual.endsWith("_derivative")) {
        assert.match(content, /唯一变化|本次唯一变化/);
        assert.match(content, /同一|same (?:person|location|object)/);
      } else {
        assert.match(content, /基础设定图|基础资产/);
      }
    }
  }
});

test("3D_rural_anime_render compiles stable rural assets and one confirmed derivative change", () => {
  const packageName = "3D_rural_anime_render";
  const methodGroups: Record<(typeof manuals)[number], RegExp[]> = {
    art_character: [
      /角色识别层级/,
      /面部拓扑与年龄感/,
      /体态、关节与绑定/,
      /发型结构/,
      /服装层级与材料/,
      /四视图规范/,
    ],
    art_character_derivative: [
      /不可变锚点/,
      /单一变化分类矩阵/,
      /材料传播规律/,
      /湿度从外层和发尾产生聚束/,
      /四视图与对照/,
    ],
    art_scene: [
      /场景分类与事实选择/,
      /功能拓扑/,
      /尺度与动画可行性/,
      /季节、时段与光线/,
      /3D乡村材质/,
      /主视图与辅助视图/,
    ],
    art_scene_derivative: [
      /连续性锁定表/,
      /单一变化矩阵/,
      /变化传播规则/,
      /同地点证明/,
      /至少两个可识别锚点/,
    ],
    art_prop: [
      /功能结构诊断/,
      /道具类型与建模重点/,
      /材料与结构规律/,
      /受力、重心与交互/,
      /多视图规范/,
    ],
    art_prop_derivative: [
      /不可变锚点/,
      /单一变化矩阵/,
      /材料传播规律/,
      /纸张\/纸箱/,
      /对照视图/,
    ],
  };

  for (const manual of manuals) {
    const content = getArtPrompt(packageName, "art_skills", manual).replace(/\r\n/g, "\n");
    assert.match(content, new RegExp(`^---\\nname: ${manual}$`, "m"), manual);
    assert.match(content, /assetFoundation/, manual);
    assert.match(content, /visualDesignRationale/, manual);
    assert.match(content, /## 职责与方法/, manual);
    assert.match(content, /## 类型专属设计方法/, manual);
    assert.match(content, /## 提示词模板（编译顺序）/, manual);
    assert.match(content, /## 输出规则/, manual);
    assert.match(content, /## 必守与严禁/, manual);
    assert.match(content, /<assetImagePrompt>/, manual);
    assert.equal((content.match(/```text\n/g) || []).length, 1, `${manual} template count`);
    assert.doesNotMatch(content, /Seedance|@reference|\bCFG\b|--ar\b|https?:\/\//i, manual);
    for (const method of methodGroups[manual]) assert.match(content, method, manual);

    const template = content.match(/```text\n([\s\S]+?)\n```/)?.[1];
    assert.ok(template, manual);
    const ordered = ["稳定事实：", "设计理由：", "专业细节：", "视图与构图：", "光线材质：", "背景：", "禁止项："];
    let previous = -1;
    for (const marker of ordered) {
      const current = template.indexOf(marker);
      assert.ok(current > previous, `${manual}: ${marker}`);
      previous = current;
    }
  }

  const character = readManual(packageName, "art_character");
  const characterDerivative = readManual(packageName, "art_character_derivative");
  const scene = readManual(packageName, "art_scene");
  const sceneDerivative = readManual(packageName, "art_scene_derivative");
  const prop = readManual(packageName, "art_prop");
  const propDerivative = readManual(packageName, "art_prop_derivative");
  assert.match(character, /汗湿、雨湿、泥尘、晒伤、疲劳、伤病、破损、劳动姿势和手持物均不自动进入基础图/);
  assert.match(character, /不使用固定身高、固定头身比、固定男女面容/);
  assert.match(characterDerivative, /一次只改变一个维度/);
  assert.match(characterDerivative, /不把一项雨湿扩展为泥污、疲劳、破损和伤病/);
  assert.match(scene, /不生成正在发生的生产事件、人物剧情或经营结果/);
  assert.match(scene, /不能为了纵深增加不存在的作物、农具、动物和建筑/);
  assert.match(sceneDerivative, /一次只改变一个条件类别/);
  assert.match(sceneDerivative, /不自动加入丰收、满仓、积水、泥泞、灾损和群众/);
  assert.match(prop, /不能自动加入果筐、电子秤、农具、包装箱、车辆、直播设备或品牌/);
  assert.match(prop, /不自动添加泥尘、受潮、锈蚀、划痕、破损和修补/);
  assert.match(propDerivative, /不把使用自动等于磨损，把湿润自动等于锈蚀或霉变/);

  for (const content of [character, characterDerivative, scene, sceneDerivative, prop, propDerivative]) {
    assert.doesNotMatch(content, /固定身高\s*\d|固定头身比\s*\d|8K|16:9|4:1|3:1|Seedance|@reference|\bCFG\b|--ar\b/i);
  }
});

test("new visual packages do not turn genre conventions into asset facts", () => {
  const republicanCharacter = readManual("realpeople_republican_period", "art_character");
  const republicanScene = readManual("realpeople_republican_period", "art_scene");
  const professionalCharacter = readManual("realpeople_professional_documentary", "art_character");
  const professionalProp = readManual("realpeople_professional_documentary", "art_prop");
  const sportsCharacter = readManual("realpeople_sports_cinematic", "art_character");
  const sportsScene = readManual("realpeople_sports_cinematic", "art_scene");
  const ruralCharacter = readManual("realpeople_rural_naturalism", "art_character");
  const ruralScene = readManual("realpeople_rural_naturalism", "art_scene");

  assert.match(republicanCharacter, /不默认旗袍、西装、军装、礼帽或武器/);
  assert.match(republicanScene, /不混入相邻职业设施|不拼贴民国符号|跨年代/);
  assert.match(professionalCharacter, /不加入警服、白大褂、法袍/);
  assert.match(professionalProp, /不虚构品牌、数据、警示和专业功能/);
  assert.match(sportsCharacter, /基础状态无汗湿、泥污、疲劳和伤病/);
  assert.match(sportsScene, /不默认室内馆、跑道、草坪、观众、记分牌和赛事品牌/);
  assert.match(ruralCharacter, /不默认晒黑、皱纹、破衣、泥污、草帽、围裙或农具/);
  assert.match(ruralScene, /作物、牲畜、炊烟、非遗和旧建筑不自动加入/);
});

test("the 66 upgraded Art manuals compile facts, rationale and output mode in the active templates", () => {
  for (const packageName of upgradedPackages) {
    for (const manual of manuals) {
      const content = readManual(packageName, manual);
      assert.match(content, /## 职责与输入契约/);
      assert.match(content, /assetFoundation/);
      assert.match(content, /visualDesignRationale/);
      assert.match(content, /## 提示词模板（编译顺序）/);
      assert.match(content, /```text\n[\s\S]+?\n```/);
      assert.equal((content.match(/```text\n/g) || []).length, 1, `${packageName}/${manual} prompt template count`);
      assert.doesNotMatch(content, /Production Agent 执行层（合并升级）/);
      assert.match(content, /<assetImagePrompt>/);
      assert.match(content, /直接润色或后台任务[\s\S]*只输出最终提示词正文/);
      assert.match(content, /最终不得残留花括号/);
      assert.doesNotMatch(content, /Seedance|@reference|\bCFG\b|--ar\b|https?:\/\//i);
      for (const requirement of styleRequirements[packageName]) {
        assert.match(content, requirement, `${packageName}/${manual}`);
      }
    }
  }
});

test("realpeople_island_survival keeps base and derivative assets inside confirmed facts", () => {
  const character = readManual("realpeople_island_survival", "art_character");
  const characterDerivative = readManual("realpeople_island_survival", "art_character_derivative");
  const scene = readManual("realpeople_island_survival", "art_scene");
  const sceneDerivative = readManual("realpeople_island_survival", "art_scene_derivative");
  const prop = readManual("realpeople_island_survival", "art_prop");
  const propDerivative = readManual("realpeople_island_survival", "art_prop_derivative");

  assert.match(character, /不预设[^。；\n]*湿衣[^。；\n]*晒伤[^。；\n]*伤口[^。；\n]*泥沙[^。；\n]*求生工具/);
  assert.match(character, /真实骨相、五官比例、年龄痕迹、毛孔和细小肤色差/);
  assert.match(character, /体态：依据已确认的身高感、骨架、肌肉或脂肪分布/);
  assert.match(character, /发际线、长度、分缝、卷直和发量/);
  assert.match(character, /内层、主服装、外层、鞋履和常态配件/);
  assert.match(characterDerivative, /只有剧本或已确认资产明确时/);
  assert.match(characterDerivative, /湿度使发丝结束、布料色深与垂坠改变/);
  assert.match(characterDerivative, /盐渍形成干燥边缘和细小结晶/);
  assert.match(characterDerivative, /伤病只表现已确认位置、外观和活动限制/);
  assert.match(scene, /不得新增洞穴、淡水点、沉船、信号火、动物、资源或灾害/);
  assert.match(scene, /海岸突出海陆方向、潮线、沿岸路线与退路/);
  assert.match(scene, /潮间带突出裸露面、积水、礁石间隙与返回边界/);
  assert.match(scene, /固定布局先于氛围/);
  assert.match(scene, /湿沙与干沙的颗粒和反射不同/);
  assert.match(sceneDerivative, /same location/);
  assert.match(sceneDerivative, /无新地点[^。；\n]*空间重构/);
  assert.match(sceneDerivative, /至少两个既有地标、海陆方向、入口出口或路线关系/);
  assert.match(sceneDerivative, /一次只选择其中一类/);
  assert.match(sceneDerivative, /不得创造新路线和新地点/);
  assert.match(prop, /不得因为荒岛题材添加求生刀、信号弹、无线电、木筏、食物/);
  assert.match(prop, /金属表现厚度、折边、焊接或紧固方式/);
  assert.match(prop, /绳索表现股线、直径、端头和已确认绳结/);
  assert.match(prop, /海岛环境不会自动产生盐渍、砂粒、锈蚀、裂纹、修补或缺损/);
  assert.match(propDerivative, /same object/);
  assert.match(propDerivative, /不新增功能/);
  assert.match(propDerivative, /湿润使表面颜色、反射或纤维重量变化/);
  assert.match(propDerivative, /裂纹须服从材料受力与纹理方向/);
  assert.match(propDerivative, /不得因变化新增零件、用途或容积/);
});

test("realpeople_island_survival templates compile in asset-specific order", () => {
  const expectedDetail: Record<(typeof manuals)[number], RegExp> = {
    art_character: /真实骨相与肤质、自然身体比例、锁定发际线和发型结构/,
    art_character_derivative: /湿度、盐渍、泥沙、磨损、伤病、发型或服装状态/,
    art_scene: /海岸、潮间带、林缘、礁石、洞穴或营地/,
    art_scene_derivative: /只重算该变化引起的可见范围、光色、阴影、表面干湿或已指定状态/,
    art_prop: /主体与连接部位、壁厚或截面、接缝紧固、开合结构和尺度/,
    art_prop_derivative: /吸水、蒸发、附着、氧化、受力或连接逻辑/,
  };

  for (const manual of manuals) {
    const content = readManual("realpeople_island_survival", manual);
    const template = content.match(/```text\n([\s\S]+?)\n```/)?.[1];
    assert.ok(template, manual);
    const ordered = ["稳定事实：", "设计理由：", "专业细节：", "视图与构图：", "光线材质：", "背景", "禁止项："];
    let previous = -1;
    for (const marker of ordered) {
      const current = template.indexOf(marker);
      assert.ok(current > previous, `${manual}: ${marker}`);
      previous = current;
    }
    assert.match(template, expectedDetail[manual], manual);
  }
});

test("base and derivative templates keep their distinct asset responsibilities", () => {
  for (const packageName of upgradedPackages) {
    const character = readManual(packageName, "art_character");
    const characterDerivative = readManual(packageName, "art_character_derivative");
    const scene = readManual(packageName, "art_scene");
    const sceneDerivative = readManual(packageName, "art_scene_derivative");
    const prop = readManual(packageName, "art_prop");
    const propDerivative = readManual(packageName, "art_prop_derivative");

    assert.match(character, /正面头像特写 \+ 正面全身 \+ 侧面全身 \+ 背面全身/);
    assert.match(characterDerivative, /same person as reference image/);
    assert.match(characterDerivative, /本次唯一变化：服装\/发型\/妆容\/配饰\/表情或状态/);
    assert.match(scene, /固定布局、入口出口、功能分区、关键物件/);
    assert.match(sceneDerivative, /same location/);
    assert.match(sceneDerivative, /(?:无新地点[^。；\n]*空间重构|不生成新地点或重构空间)/);
    assert.match(prop, /正面 \+ 侧面 \+ 背面或底部 \+ (?:关键接缝和)?材质(?:\/接缝)?细节特写/);
    assert.match(propDerivative, /same object/);
    assert.match(propDerivative, /不换物、不新增功能/);
  }
});

test("each upgraded visual package retains a distinct prompt vocabulary", () => {
  const templates = new Set<string>();
  for (const packageName of upgradedPackages) {
    const content = readManual(packageName, "art_character");
    const template = content.match(/```text\n([\s\S]+?)\n```/)?.[1];
    assert.ok(template, packageName);
    templates.add(template);
  }
  assert.equal(templates.size, upgradedPackages.length);
});

test("the six realpeople_urban_modern Art references remain unchanged", () => {
  for (const manual of manuals) {
    assert.equal(sha256(manualPath(referencePackage, manual)), referenceHashes[manual], manual);
  }
});

test("the live code paths select base and derivative Art manuals", () => {
  const background = fs.readFileSync(path.join(process.cwd(), "src", "services", "backgroundTaskHandlers.ts"), "utf8");
  const foundation = fs.readFileSync(path.join(process.cwd(), "src", "services", "assetFoundation.ts"), "utf8");
  const direct = fs.readFileSync(path.join(process.cwd(), "src", "routes", "assetsGenerate", "polishAssetsPrompt.ts"), "utf8");

  for (const manual of manuals) {
    assert.match(`${background}\n${foundation}\n${direct}`, new RegExp(`"${manual}"`), manual);
  }
  assert.match(background, /asset\.assetsId \? config\.derivativeManual : config\.visualManual/);
  assert.match(direct, /assetsData\.assetsId \? "art_character_derivative" : "art_character"/);
  assert.match(foundation, /<assetImagePrompt>图片生成 prompt<\/assetImagePrompt>/);
});
