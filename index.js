require("dotenv").config();

const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const TEST_PAGE_ID = "35d90573-c94b-80e1-8a32-e330c0f7e8cd";
const REFERENCE_DB_ID = process.env.REFERENCE_DB_ID;

const REF_TITLE_PROP = "이름";
const REF_RELATION_PROP = "🧸 광고 소재";

async function getPageTitle(page) {
  const titleProp = Object.values(page.properties).find(
    (prop) => prop.type === "title"
  );

  return titleProp?.title?.[0]?.plain_text || "제목 없음";
}

async function findMediaBlocks(blockId, mediaBlocks = []) {
  const children = await notion.blocks.children.list({
    block_id: blockId,
    page_size: 100,
  });

  for (const block of children.results) {
    if (block.type === "video") {
      mediaBlocks.push({
        id: block.id,
        type: "video",
        name: "영상",
      });
    }

    if (block.type === "file") {
      const fileName = block.file?.name || "파일";

      if (
        fileName.toLowerCase().endsWith(".mp4") ||
        fileName.toLowerCase().endsWith(".mov") ||
        fileName.toLowerCase().endsWith(".webm")
      ) {
        mediaBlocks.push({
          id: block.id,
          type: "file",
          name: fileName,
        });
      }
    }

    if (block.has_children) {
      await findMediaBlocks(block.id, mediaBlocks);
    }
  }

  return mediaBlocks;
}

async function createReferencePage({ title, contentPageId }) {
  await notion.pages.create({
    parent: {
      data_source_id: REFERENCE_DB_ID,
    },
    properties: {
      [REF_TITLE_PROP]: {
        title: [
          {
            text: {
              content: title,
            },
          },
        ],
      },
      [REF_RELATION_PROP]: {
        relation: [
          {
            id: contentPageId,
          },
        ],
      },
    },
  });
}

async function main() {
  const page = await notion.pages.retrieve({
    page_id: TEST_PAGE_ID,
  });

  const pageTitle = await getPageTitle(page);

  console.log(`검사할 페이지: ${pageTitle}`);

  const mediaBlocks = await findMediaBlocks(TEST_PAGE_ID);

  console.log(`영상/미디어 블록 ${mediaBlocks.length}개 발견`);

  let created = 0;

  for (let i = 0; i < mediaBlocks.length; i++) {
    const media = mediaBlocks[i];

    const title =
      media.type === "file"
        ? `${pageTitle} - ${media.name}`
        : `${pageTitle} - 레퍼런스 ${i + 1}`;

    await createReferencePage({
      title,
      contentPageId: TEST_PAGE_ID,
    });

    console.log(`생성 완료: ${title}`);
    created++;
  }

  console.log("");
  console.log("완료");
  console.log(`생성: ${created}`);
}

main().catch(console.error);