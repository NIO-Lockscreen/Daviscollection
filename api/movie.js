
import { kv } from '@vercel/kv'

export default async function handler(req, res){

  const id = req.query.id

  let movies = await kv.get('movies') || []

  const index = movies.findIndex(m => m.id === id)

  if(index === -1){
    return res.status(404).json({
      error:'Movie not found'
    })
  }

  if(req.method === 'PUT'){

    movies[index] = {
      ...movies[index],
      ...req.body
    }

    await kv.set('movies', movies)

    return res.status(200).json(movies[index])
  }

  if(req.method === 'DELETE'){

    movies.splice(index, 1)

    await kv.set('movies', movies)

    return res.status(200).json({
      success:true
    })
  }
}
