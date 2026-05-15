
import { kv } from '@vercel/kv'

export default async function handler(req, res){

  let movies = await kv.get('movies') || []

  if(req.method === 'GET'){
    return res.status(200).json({ movies })
  }

  if(req.method === 'POST'){

    const movie = req.body

    movies.push(movie)

    await kv.set('movies', movies)

    return res.status(200).json({
      success:true
    })
  }
}
