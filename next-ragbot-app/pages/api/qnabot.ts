//호출주소: http://localhost:3000/api/qnabot
import type { NextApiRequest, NextApiResponse } from "next";

//웹페이지 크롤링을 위한 cheerio 패키지 참조하기
//npm i cheerio 설치필요
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";

//텍스트 분할기 객체 참조하기
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { pull } from "langchain/hub";
import { createStuffDocumentsChain } from "langchain/chains/combine_documents";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { IMemberMessage, UserType } from "@/interfaces/message";

//API 호출 결과 반환 데이터 타입 정의
type ResponseData = {
  code: number;
  data: string | null | IMemberMessage;
  msg: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  let apiResult: ResponseData = {
    code: 400,
    data: null,
    msg: "Failed",
  };

  try {
    if (req.method === "POST") {
      const message = req.body.message;
      const nickName = req.body.nickName;

      //Step1:Indexing 웹페이지 로더 객체 생성하고 페이지 로딩하기
      //Step1-1: 웹페이지 로딩하기
      const loader = new CheerioWebBaseLoader(
        "https://api.ncloud-docs.com/docs/common-ncpapi"
      );
      const docs = await loader.load();

      //Step1-2: 텍스트 분할기 객체 생성(chunk) 및 텍스트 분할하기 -> 인덱싱 과정
      const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
      });

      //텍스트 분할처리하기
      const splitedDoc = await textSplitter.splitDocuments(docs);

      //Step1-3: 임베딩 처리(split된 단어를 벡터 데이터화 처리)하고 벡터저장소에 저장하기
      //임베딩 시에는 반드시 지정된 임베딩 모델을 통해 임베딩처리합니다.
      const vectorStore = await MemoryVectorStore.fromDocuments(
        splitedDoc,
        new OpenAIEmbeddings()
      );

      //Step2: 임베딩된 데이터 조회하기 (리트리버실시)
      //검색기 생성하기
      const retriever = vectorStore.asRetriever();
      //사용자 질문을 이용해 벡터저장소를 조회하고 조회결과를 반환받는다.
      //실제 조회한 결과물 자체
      const retrieverResult = await retriever.invoke(message);

      //Step3:RAG 기반(증강된 검색데이터를 통한) LLM 호출하기
      const gptModel = new ChatOpenAI({
        model: "gpt-4o",
        temperature: 0.2,
        apiKey: process.env.OPENAI_API_KEY,
      });

      //rag전용 프롬프트 템플릿 생성
      const ragPrompt = await pull<ChatPromptTemplate>("rlm/rag-prompt");

      //rag전용 프롬프트 기반 체인 생성하기
      const ragChain = await createStuffDocumentsChain({
        llm: gptModel,
        prompt: ragPrompt,
        outputParser: new StringOutputParser(),
      });

      //체인 실행해서 rag 조회결과를 llm에 전달하고 결과 받아오기
      const resultMessage = await ragChain.invoke({
        question: message,
        context: retrieverResult,
      });

      //RESTFul API 챗봇 응답 메시지 포맷 정의하기
      const resultMsg: IMemberMessage = {
        user_type: UserType.BOT,
        nick_name: "bot",
        message: resultMessage,
        send_date: new Date(),
      };

      apiResult.code = 200;
      apiResult.data = resultMsg;
      apiResult.msg = "Ok";
    }
  } catch (err) {
    const resultMsg: IMemberMessage = {
      user_type: UserType.BOT,
      nick_name: "bot",
      message: "챗봇에러발생",
      send_date: new Date(),
    };

    apiResult.code = 500;
    apiResult.data = resultMsg;
    apiResult.msg = "Server Error Failed";
  }

  res.json(apiResult);
}
