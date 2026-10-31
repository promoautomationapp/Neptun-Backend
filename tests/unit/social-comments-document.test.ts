import { postSchema } from "../../src/modules/documents/domain/document";

describe("social post annotations", () => {
  test("validates brochure-compatible comment records and preserves text layers", () => {
    const comment = { id:"comment",pageIndex:0,text:"Check price",authorEmail:"staff@example.test",createdAt:new Date().toISOString(),position:{x:25,y:40} };
    const post = postSchema.parse({id:"post",products:[],reviewComments:[comment],reviewHistory:[{id:"action",action:"comment",actor:"staff@example.test",role:"staff",at:comment.createdAt,commentId:"comment"}],artworks:[{id:"text",type:"text",text:"Offer",x:10,y:20,width:25,fontSize:4}]});
    expect(post.reviewComments?.[0]).toEqual({...comment,replies:[],fixed:false});
    expect(post.reviewHistory?.[0]).toMatchObject({action:"comment",commentId:"comment"});
    expect(post.artworks).toEqual([{id:"text",type:"text",text:"Offer",x:10,y:20,width:25,fontSize:4}]);
    expect(postSchema.safeParse({id:"post",products:[],reviewComments:[{...comment,position:{x:"bad",y:20}}]}).success).toBe(false);
  });
  test("leaves legacy post responses unchanged when they have no review fields", () => {
    expect(postSchema.parse({id:"post",name:"Old post",products:[]})).toEqual({id:"post",name:"Old post",products:[]});
  });
});
