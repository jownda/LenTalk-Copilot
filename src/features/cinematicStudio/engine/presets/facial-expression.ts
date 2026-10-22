/**
 * 人物表情参考模板（来自《人物表情提示词》整理）。
 *
 * 这是表演技巧的辅助查表，不是情绪标签生成器：AI 只能在场景已有
 * 情绪触发和表演目标时选用匹配条目，并把它改写成角色当下的可观察行为。
 */
export interface FacialExpressionTemplate {
  id: string;
  emotion: string;
  category: "喜悦" | "愤怒" | "悲伤" | "惊恐" | "复杂/复合";
  mouth: string;
  eyes: string;
  face: string;
  head: string;
}

export const FACIAL_EXPRESSION_TEMPLATES: FacialExpressionTemplate[] = [
  { id: "natural-smile", emotion: "自然微笑", category: "喜悦", mouth: "嘴角微微上扬，双唇自然闭合", eyes: "眼神柔和自然，略有微光", face: "面部肌肉完全放松，苹果肌微显", head: "头部保持中立或微侧" },
  { id: "open-laughter", emotion: "开怀大笑", category: "喜悦", mouth: "嘴角大幅上扬，张嘴露出整齐牙齿", eyes: "双眼眯成弯月状，眼角有自然笑纹", face: "苹果肌明显隆起并向上提拉", head: "头部放松向后仰起" },
  { id: "ecstatic-excitement", emotion: "狂喜激动", category: "喜悦", mouth: "嘴巴微张，嘴角不受控地剧烈上扬", eyes: "双眼睁大，瞳孔放大且熠熠放光", face: "面部肌肉紧绷，伴随血液循环涨红", head: "头部前倾或兴奋地点动" },
  { id: "relieved-soft-smile", emotion: "欣慰浅笑", category: "喜悦", mouth: "嘴角缓慢浮现一丝舒缓的弧度", eyes: "目光微微低垂且温柔，略带湿润感", face: "面部线条柔和，疲惫但完全舒展", head: "头部轻微点头，表达认可" },
  { id: "shy-delight", emotion: "娇羞窃喜", category: "喜悦", mouth: "用力抿住双唇，试图掩饰上扬的嘴角", eyes: "眼神躲闪，不敢直视，眼波快速流转", face: "脸颊两侧泛起明显的粉红晕染", head: "头部低垂并微微侧向一边" },
  { id: "simple-minded-grin", emotion: "憨厚傻笑", category: "喜悦", mouth: "半张着嘴，嘴角略显歪斜地上扬", eyes: "眼神失去锐利焦点，略显呆滞与单纯", face: "面部肌肉松垮下垂，无防备感", head: "头部微微歪向一侧并保持静止" },
  { id: "benevolent-warmth", emotion: "慈祥和蔼", category: "喜悦", mouth: "嘴角平缓、持久且温和地微笑", eyes: "眼角布满岁月的深笑纹，目光充满包容", face: "面部肌肉松弛但充满暖意与亲和力", head: "头部微微前倾，专注注视" },
  { id: "relieved-smile", emotion: "释然微笑", category: "喜悦", mouth: "长舒一口气后，嘴角微微放松地勾起", eyes: "眼神从紧绷转为清澈透明", face: "眉头彻底舒展，整张脸空灵放松", head: "头部向上仰望或轻盈摇动" },
  { id: "smug-pride", emotion: "得意洋洋", category: "喜悦", mouth: "单侧嘴角斜向极度上扬，呈戏谑斜笑", eyes: "眼神挑衅，一侧眉毛高高挑起", face: "下巴不自觉向前凸出，肌肉紧绷", head: "头部高昂，视线向下俯视" },
  { id: "obsequious-pleasing", emotion: "谄媚讨好", category: "喜悦", mouth: "强行挤出夸张笑容，露出过多上排牙齿", eyes: "眼神飘忽不定，时刻观察对方", face: "面部肌肉僵硬、不自然地紧绷", head: "头部小幅、频繁地点动" },
  { id: "thunderous-rage", emotion: "雷霆狂怒", category: "愤怒", mouth: "嘴巴大张，呈咆哮怒吼状，露出牙齿", eyes: "怒目圆睁，红血丝充血，瞳孔极度收缩", face: "额头与太阳穴青筋暴起，五官扭曲", head: "头部带攻击性地向前冲" },
  { id: "contained-anger", emotion: "隐忍怒意", category: "愤怒", mouth: "双唇紧闭成冰冷直线，咬牙切齿", eyes: "目光如利刃盯住目标，眉头压低", face: "两侧咬肌凸起，面部肌肉微微抽搐", head: "头部僵硬不动，下巴微微下沉" },
  { id: "humiliated-anger", emotion: "恼羞成怒", category: "愤怒", mouth: "嘴唇气愤发抖，嘴角用力向下撇", eyes: "眼神先慌乱闪躲，再转为凶狠敌意", face: "脸庞涨红，呼吸粗重", head: "头部急促转向一侧后猛地回头" },
  { id: "arrogant-contempt", emotion: "高傲鄙视", category: "愤怒", mouth: "单侧嘴角轻蔑、不屑地下撇", eyes: "眼皮半垂，斜视对方", face: "面部冷漠、僵硬且傲慢", head: "头部高高仰起，用鼻孔俯视" },
  { id: "playful-irritation", emotion: "嗔怒娇嗔", category: "愤怒", mouth: "微微嘟起嘴唇，嘴角假装下垂", eyes: "双眼睁大但无实际杀伤力，眼波流转", face: "双颊微微鼓起，显得娇俏", head: "头部带节奏地快速扭向一侧" },
  { id: "jealous-rage", emotion: "嫉妒之怒", category: "愤怒", mouth: "嘴角不自觉抽动，死死咬住下唇", eyes: "眼神阴暗偏激，从眼角斜视目标", face: "面部呈不自然的苍白或铁青色", head: "头部低垂，眼神向上偷瞄" },
  { id: "righteous-fury", emotion: "义愤填膺", category: "愤怒", mouth: "嘴角坚毅地下压，双唇开合进行控诉", eyes: "双眼炯炯有神，目光坚定正气", face: "眉心紧锁成利落的川字", head: "头部挺直，随控诉节奏有力点动" },
  { id: "irritable", emotion: "烦躁易怒", category: "愤怒", mouth: "频繁咂嘴，嘴角烦躁地向两侧拉扯", eyes: "眼神焦躁不安，视线飘忽难以集中", face: "眉头紧皱，面部写满不耐烦", head: "头部频繁左右摇晃或无奈后仰" },
  { id: "cold-killing-intent", emotion: "冷酷杀意", category: "愤怒", mouth: "嘴角毫无波澜，噙着无温度的冷笑", eyes: "眼神空洞、深邃而冰冷，视人如死物", face: "面部如大理石般凝固", head: "头部极其缓慢、机械地转向目标" },
  { id: "stifled-frustration", emotion: "憋屈闷气", category: "愤怒", mouth: "双唇紧闭向内抿入，伴随频繁吞咽", eyes: "眼神向下压，眼眶微红带泪", face: "面颊紧绷，鼻翼因憋气翕动", head: "头部深深耷拉，拒绝对视" },
  { id: "silent-tears", emotion: "无声落泪", category: "悲伤", mouth: "嘴角颤抖着向下无力压低", eyes: "泪水滑落，眼神空洞失去高光", face: "面容憔悴苍白，泪痕清晰", head: "头部无力下垂并保持静止" },
  { id: "sobbing-cry", emotion: "嚎啕大哭", category: "悲伤", mouth: "嘴巴完全痛苦张开，放声悲鸣", eyes: "双眼紧闭，大量泪水与鼻涕横流", face: "面部肌肉剧烈扭曲挤压", head: "头部随痛苦剧烈摇晃并连续后仰" },
  { id: "choked-sobbing", emotion: "抽泣哽咽", category: "悲伤", mouth: "嘴唇哆嗦，不停倒吸凉气", eyes: "眼睑红肿，泪水在眼眶中打转", face: "下巴因强忍抽泣规律颤抖", head: "头部随抽泣节奏一顿一顿地抽动" },
  { id: "melancholy", emotion: "忧郁惆怅", category: "悲伤", mouth: "嘴角无力、松弛地自然下垂", eyes: "眼神迷茫忧伤，失神望向远方", face: "双眉微蹙，面容平静却带清愁", head: "头部轻微偏向一侧" },
  { id: "hopeless", emotion: "绝望死心", category: "悲伤", mouth: "嘴唇干裂、无力微张，失去紧绷力", eyes: "双眼失去焦距，毫无生气", face: "所有线条放松，麻木近乎瘫痪", head: "头部软弱无力地耷拉" },
  { id: "pouty-hurt", emotion: "委屈巴巴", category: "悲伤", mouth: "下嘴唇向前突起，上唇紧闭下压", eyes: "眼睛睁大且水汪汪，采取仰视目光", face: "鼻尖微红，脸颊气鼓鼓地凸起", head: "头部瑟缩并微微后退" },
  { id: "pleading-piteous", emotion: "凄凉哀求", category: "悲伤", mouth: "嘴角颤抖着张开，断断续续试图诉说", eyes: "含泪直视对方，目光卑微无助", face: "眉峰高耸，形成典型八字眉", head: "头部卑微地向前倾斜" },
  { id: "heartbreak", emotion: "心如刀绞", category: "悲伤", mouth: "牙齿咬住下嘴唇，直到嘴唇发白", eyes: "因窒息式痛苦死死闭上双眼", face: "五官向中心痛苦挤压", head: "头部承受重击般猛烈低垂" },
  { id: "compassion", emotion: "悲悯同情", category: "悲伤", mouth: "嘴角带无声哀叹，微微向下压低", eyes: "眼神柔和，充满不忍", face: "面部线条温润包容，眉头轻聚", head: "头部伴随痛惜轻轻左右摇晃" },
  { id: "bitter-smile", emotion: "无奈苦笑", category: "悲伤", mouth: "单侧嘴角不自然地上扬，带自嘲意味", eyes: "眼神充满深沉悲伤与无可奈何", face: "一半似笑一半似哭，形成割裂感", head: "头部微偏，伴随叹气沉重摇动" },
  { id: "extreme-terror", emotion: "极度惊恐", category: "惊恐", mouth: "嘴巴不受控地张大成惨烈 O 型", eyes: "眼球几乎凸出，瞳孔瞬间缩小", face: "面庞惨白，额头冷汗直流", head: "头部和身体极速向后躲闪" },
  { id: "stunned-silence", emotion: "目瞪口呆", category: "惊恐", mouth: "下巴失去支撑掉落，嘴巴半张", eyes: "双眼暴睁，视线锁在一点", face: "表情肌瞬间定格硬化", head: "头部停止运动，僵硬不动" },
  { id: "horrified-tremor", emotion: "惊悚战栗", category: "惊恐", mouth: "牙齿剧烈打颤，发出咯咯声", eyes: "眼神充满绝望，眼球快速震颤", face: "面部肌肉神经质抽搐", head: "头部不受控地高频左右轻晃" },
  { id: "uneasy-alarm", emotion: "惶恐不安", category: "惊恐", mouth: "艰难吞咽，嘴唇发干微张", eyes: "眼珠警惕地左右转动", face: "眉头深锁，额头布满冷汗", head: "头部神经质地四处张望" },
  { id: "guarded-alert", emotion: "警惕防备", category: "惊恐", mouth: "双唇紧闭，嘴角向两侧拉扯后锁死", eyes: "双眼微眯，死盯暗处", face: "咬肌绷紧，下颌线生硬", head: "头部微沉，下巴收紧进入防卫姿态" },
  { id: "realization", emotion: "恍然大悟", category: "惊恐", mouth: "嘴巴微张，发出舒畅的短促轻叹", eyes: "迷茫的眼睛瞬间睁大增亮", face: "双眉挑起，面部豁然开朗", head: "头部随思绪顿开微微后仰" },
  { id: "pleasant-surprise", emotion: "意外惊喜", category: "惊恐", mouth: "嘴巴微张后瞬间转为灿烂大笑", eyes: "双眼圆睁后迅速弯成月牙", face: "苹果肌极速提拉，面颊红润", head: "头部高频点动并微微前倾确认" },
  { id: "speechless-astonishment", emotion: "错愕无语", category: "惊恐", mouth: "单侧嘴角机械抽动后定格微张", eyes: "眨眼极少，眼神荒谬而不解", face: "半边眉毛夸张挑高", head: "头部向一侧极度不解地歪斜" },
  { id: "awe", emotion: "敬畏震撼", category: "惊恐", mouth: "嘴巴自然微张，呼吸变得轻微小心", eyes: "眼神带神圣仰望光芒，眼眶微红", face: "神情庄重肃穆，摒弃杂念", head: "头部带崇拜感微微仰望" },
  { id: "startled-inhale", emotion: "惊醒倒吸气", category: "惊恐", mouth: "猛烈倒吸凉气，嘴巴瞬间大张", eyes: "双眼猛然暴睁，眼底惊魂未定", face: "整张脸惨白，额角流下冷汗", head: "头部、脖颈和上半身随呼吸向后弹起" },
  { id: "cold-indifference", emotion: "冷漠无视", category: "复杂/复合", mouth: "双唇自然闭合，没有情绪弧度", eyes: "眼神冰冷，视线越过交谈者", face: "面部肌肉静止，如冰山雕塑", head: "头部保持物理中立，不偏移" },
  { id: "haughty-disdain", emotion: "傲慢轻视", category: "复杂/复合", mouth: "单侧嘴角挂若有若无的讽刺笑", eyes: "眼皮半垂，用余光向下扫视", face: "下巴上扬，面部松弛自负", head: "头部高昂，呈居高临下姿态" },
  { id: "intense-focus", emotion: "高度专注", category: "复杂/复合", mouth: "双唇紧抿成坚固线条", eyes: "目光精准锁定，极少眨眼", face: "眉心向中心聚拢，面部进入运转状态", head: "头部微前倾，随目标平稳跟移" },
  { id: "confused", emotion: "迷茫困惑", category: "复杂/复合", mouth: "嘴唇微张，偶尔轻咬下唇", eyes: "眼神失焦，写满不解与迷失", face: "眉头微皱，面部呈深度思索感", head: "头部缓慢歪斜，随后轻轻摇头" },
  { id: "teasing-allure", emotion: "挑逗魅惑", category: "复杂/复合", mouth: "嘴角诱惑地微勾，舌尖轻舔嘴唇", eyes: "眼神迷离，眼尾上挑并抛媚眼", face: "双颊潮红，面部灵动狡黠", head: "头部轻盈微侧，下巴内收后抬眸" },
  { id: "thoughtful-deliberation", emotion: "沉思推敲", category: "复杂/复合", mouth: "嘴唇冷峻紧闭，嘴角偶尔抽动", eyes: "目光时而向下，时而看向斜上方", face: "眉头紧锁，进入忘我沉思", head: "头部微微下垂或保持静止" },
  { id: "physical-disgust", emotion: "生理厌恶", category: "复杂/复合", mouth: "嘴角痛苦向下拉扯，甚至干呕", eyes: "双眼嫌弃地眯起或避开视线", face: "鼻子皱起，五官抗拒地缩在一起", head: "头部如触电般向后躲避、转开" },
  { id: "social-awkwardness", emotion: "社交尴尬", category: "复杂/复合", mouth: "强行挤出僵硬、不对称的假笑", eyes: "眼神游离，四处寻找逃离出口", face: "面颊肌肉僵硬，嘴角神经质抽搐", head: "头部向肩膀内缩，降低存在感" },
  { id: "lazy-fatigue", emotion: "慵懒疲惫", category: "复杂/复合", mouth: "嘴巴半张，缺乏闭合双唇的力气", eyes: "眼皮沉重半睁半闭，带疲劳红血丝", face: "面部肌肉下垂拉垮，毫无生气", head: "头部无力后瘫或随身体东倒西歪" },
  { id: "unyielding-resolve", emotion: "坚毅不屈", category: "复杂/复合", mouth: "双唇死死紧抿成铁线", eyes: "目光坚定锐利，直视前方", face: "下颌骨线条紧绷，充满力量", head: "头部高昂，带骄傲迎接挑战" },
];

/** 给 AI 的紧凑查表文本；只在生成表演时作为可选参考。 */
export function facialExpressionReferencePrompt(): string {
  return FACIAL_EXPRESSION_TEMPLATES
    .map((template, index) => `${String(index + 1).padStart(2, "0")}.${template.emotion}｜嘴：${template.mouth}；眼：${template.eyes}；面：${template.face}；头：${template.head}`)
    .join("\n");
}

