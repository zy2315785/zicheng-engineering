import fs from 'node:fs';
// Synthetic text fixtures keep unit tests independent of private Blob contents.
const catalogue=JSON.parse(fs.readFileSync(new URL('../dist/project-data.json',import.meta.url),'utf8')).documents;
const sample=(id,name,text,category='前期报建')=>({id,name,path:name,project:'ruibang',type:'xlsx',category,status:'indexed',chunks:[{location:'测试工作表 · 第1–3行',text}]});
export const docs=process.env.TEST_PRIVATE_DATA?JSON.parse(fs.readFileSync(process.env.TEST_PRIVATE_DATA,'utf8')).documents:[...catalogue,
 sample('fixture-permit','施工许可证办理所需资料(新).xlsx','施工许可证办理所需资料：规划许可、合同、资料清单。'),
 sample('fixture-plan','瑞邦国际大厦项目进展倒排计划.xlsx','瑞邦国际大厦项目进展倒排计划，项目建设事项、计划进展及倒排计划。','计划管理'),
 sample('fixture-schedule','中关村总进度计划.xlsx',`总进度计划：${new Date().getFullYear()}年1月1日 至 ${new Date().getFullYear()}年12月31日 主体工程施工阶段，施工进度、计划开工和计划完工。`,'计划管理')
];
